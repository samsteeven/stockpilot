# StockPilot : stocks, réservations et commandes pour plusieurs entreprises, sans jamais vendre ce qu'on n'a pas

Plateforme SaaS B2B de gestion des stocks, des commandes et des expéditions, en **NestJS + TypeScript + PostgreSQL** (monorepo **Nx**, **Prisma**, **Redis + BullMQ**), front **Angular**, tests navigateur **Cypress**. Une entreprise gère plusieurs entrepôts ; quand deux clients commandent en même temps les dernières unités, une seule commande passe, et les données d'une entreprise restent invisibles pour les autres, **garanti par la base elle-même**.

> **État : incrément 5.** Journaux JSON corrélés et métriques Prometheus (API et worker), alertes testées, tableau de bord Grafana ; **tests de charge k6** (aucune survente sous rafale, limite d'une instance mesurée et expliquée) ; sécurité de la chaîne d'approvisionnement (audit bloquant, SBOM, licences, signatures, actions épinglées, secrets, CodeQL). Avant : expéditions, e-mails, front Angular et Cypress (4) ; commandes, paiement signé, outbox, audit (3) ; comptes et rôles (2) ; moteur de stock et Row-Level Security (1). Voir [la feuille de route](#feuille-de-route).

> **Incrément 6 en cours** : déploiement sur AWS écrit et vérifié sans compte (Terraform validé, configuration analysée, images construites puis démarrées comme en production dans la CI) ; exécution réelle et scénarios de panne : voir [docs/exploitation](docs/exploitation/README.md).

## Le cœur : 20 commandes pour 5 unités

```text
$ node scripts/demo-concurrence.mjs
Avant : 5 en stock, 0 réservés, 5 disponibles
20 commandes simultanées en 231 ms : {"201":5,"409":15} (201 = réservé, 409 = stock insuffisant)
Après : 5 en stock, 5 réservés, 0 disponibles
Aucune survente.
```

_Contre l'API et le worker construits, avec un compte connecté, sur le poste de développement ; rejoué à chaque push par la CI, suivi de l'expiration des réservations par le worker._

La garantie ne vient pas d'une vérification en code (deux requêtes liraient toutes deux « 5 disponibles ») mais d'une mise à jour conditionnelle, et la base refuse de toute façon un réservé supérieur au physique :

```sql
UPDATE stock_items
SET quantity_reserved = quantity_reserved + $quantité, version = version + 1
WHERE id = $ligne AND quantity_on_hand - quantity_reserved >= $quantité
RETURNING id;   -- aucune ligne : stock insuffisant
```

## Le parcours d'une commande

```text
$ node scripts/demo-commande.mjs
1. Commande de 3 câbles, envoyée deux fois avec la même clé, puis payée
OK   commande créée (37.50 EUR)
OK   même clé : même commande, réponse rejouée
OK   même clé, autre contenu : refusée
OK   paiement accepté : commande confirmée
OK   notification renvoyée : sans effet
2. Commande dont le paiement est refusé
OK   commande annulée (payment_failed)
3. Commande non payée à temps, puis paiement tardif
OK   annulée par le worker à l’échéance (CANCELLED)
OK   paiement tardif : remboursement exigé
```

_Extrait ; contre l'API et le worker construits, le script jouant le prestataire de paiement (notifications signées HMAC). Rejoué à chaque push par la CI._

```
POST /orders (Idempotency-Key) ── une transaction : commande + lignes au prix du catalogue + réservation
                                  + paiement attendu + historique + audit + événement + clé d'idempotence
        │
        ├─ notification « payé » (signée)   ── réservation encore valide → sortie de stock, commande confirmée
        │                                   └─ réservation échue       → rien ne sort, annulée, à rembourser
        ├─ notification « refusé » (signée) ── réservation rendue, commande annulée
        └─ rien avant l'échéance ── worker : réservation expirée ─► outbox ─► file ─► commande annulée
```

## Sous charge

```text
$ k6 run tests/load/contention.js        # 200 acheteurs pour les 50 dernières unités
✓ reservations_acceptees  count==50       ✓ reservations_refusees  count==150
✓ réservé = physique, jamais au-delà      ✓ http_req_failed  rate==0
```

| Charge (poste de développement) | Débit     | p95 création de commande | Erreurs |
| ------------------------------- | --------- | ------------------------ | ------- |
| 20 vendeurs                     | 50 req/s  | 67 ms                    | 0       |
| 100 vendeurs                    | 126 req/s | 759 ms                   | 0       |

À 100 vendeurs, le processus de l'API occupe un cœur entier quand PostgreSQL n'en occupe que 1,2 sur 16 : la limite est **une instance de l'API**, pas la base ; agrandir le pool de connexions n'y change rien (mesuré). Détail, hypothèses vérifiées et écartées : [tests/load/RESULTATS.md](tests/load/RESULTATS.md).

## Ce qui est vérifié, et ce qui ne l'est pas

| Élément                     | Vérifié                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Pas vérifié                                                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pas de survente             | 20 réservations simultanées pour 5 unités, **10 tours** : exactement 5 passent ; 2 × 4 pour 5 : une seule ; en HTTP contre les applications construites (CI)                                                                                                                                                                                                                                                                                                                            | Sous charge prolongée, sur plusieurs instances de l'API (incrément 5)                                                                                                         |
| Tout ou rien, interblocages | Une ligne en défaut annule toute la commande ; commandes A+B et B+A simultanées sans erreur (ordre de verrouillage fixe)                                                                                                                                                                                                                                                                                                                                                                | Le test d'interblocage repose sur une probabilité ([ADR-007](docs/architecture/adr/007-tests-contre-vraies-bases.md))                                                         |
| Idempotence                 | La même référence envoyée 10 fois en même temps ne réserve qu'une fois ; **`Idempotency-Key`** : la même commande envoyée 10 fois en même temps donne une commande et une réservation, les 9 autres reçoivent la même réponse ; même clé avec une autre commande : 422                                                                                                                                                                                                                  | Purge des clés anciennes                                                                                                                                                      |
| Paiement                    | Notification signée (HMAC de l'horodatage et du corps brut) : fausse, d'un autre secret, de plus de 5 minutes ou sur un corps modifié, refusée ; renvoyée, sans effet ; montant inattendu, refusé ; le prix vient du catalogue, jamais du client                                                                                                                                                                                                                                        | Prestataire réel (simulé par les tests et la démo) ; remboursement exigé mais pas exécuté                                                                                     |
| Compensation                | Paiement refusé : réservation rendue, commande annulée ; paiement après l'échéance ou après une annulation : rien ne sort du stock, remboursement exigé ; pas de paiement à temps : le worker annule la commande                                                                                                                                                                                                                                                                        |                                                                                                                                                                               |
| Outbox                      | Événement d'une transaction annulée absent ; publication unique ; échec compté puis rattrapé ; deux publicateurs simultanés sans doublon ; événement livré deux fois traité une fois ; chaîne réservation expirée → outbox → file → commande annulée sur un vrai worker                                                                                                                                                                                                                 | Redémarrage de Redis en pleine publication                                                                                                                                    |
| Expéditions                 | Une seule par commande confirmée (événement relivré), aucune pour une commande non payée ; prête → expédiée → livrée, sans retour ni saut, même par une requête SQL directe ; suivi obligatoire ; expédiées par le responsable d'entrepôt, pas par l'opérateur                                                                                                                                                                                                                          | Transporteur réel (numéro saisi à la main)                                                                                                                                    |
| E-mails aux clients         | Sur un vrai serveur SMTP : confirmation, expédition avec le numéro de suivi, livraison ; serveur en panne puis rétabli : **un seul message reçu**, deux essais notés ; un message déjà envoyé n'est pas renvoyé                                                                                                                                                                                                                                                                         | Délivrabilité réelle (SES, incrément 6)                                                                                                                                       |
| Front                       | Dans un vrai navigateur (Cypress) : connexion, session, commande créée puis annulée (stock réservé puis rendu), **double clic = une commande**, stock insuffisant, parcours payé → expédié → livré avec les messages au client, ce que voit chaque rôle                                                                                                                                                                                                                                 | Accessibilité, mobile                                                                                                                                                         |
| Un seul état final          | Confirmation contre libération simultanées (20 tours) : un seul gagnant ; confirmer deux fois ne sort le stock qu'une fois ; expiration trop tôt ou en double sans effet                                                                                                                                                                                                                                                                                                                |                                                                                                                                                                               |
| Expiration                  | Worker réel sur une vraie file BullMQ ; balayage qui rattrape une réservation dont le job a été perdu                                                                                                                                                                                                                                                                                                                                                                                   | Redémarrage de Redis en plein traitement                                                                                                                                      |
| Sessions                    | Argon2id borné en concurrence ; même réponse pour un e-mail inconnu et un mauvais mot de passe ; cookie `HttpOnly`, `SameSite=Strict`, limité à `/api/v1/auth` ; rotation à chaque renouvellement ; **un jeton rejoué révoque toute la session** ; en-tête anti-CSRF ; jeton falsifié ou expiré refusé ; limite de débit à la connexion (429) ; dans le navigateur : aucun jeton stocké, session retrouvée au rechargement, **un seul renouvellement pour plusieurs requêtes expirées** | Deux onglets qui renouvellent au même instant ([ADR-008](docs/architecture/adr/008-comptes-et-sessions.md)) ; vérification d'adresse e-mail                                   |
| Rôles                       | **Matrice entière** (5 rôles × 8 actions) ; un membre retiré perd l'accès à la requête suivante ; un rôle abaissé s'applique tout de suite ; un administrateur ne touche pas aux propriétaires ; le dernier propriétaire ne peut ni partir ni être rétrogradé, même par une requête SQL directe ; un lecteur ne crée pas de commande                                                                                                                                                    |                                                                                                                                                                               |
| Audit                       | Rôles, retraits, invitations, commandes et paiements tracés dans la transaction de l'action ; lisible par le propriétaire et l'administrateur seulement ; **ni modification ni suppression, même par le propriétaire des tables** (déclencheur), comme l'historique des statuts ; une commande confirmée ou annulée, un paiement réglé ne changent plus                                                                                                                                 | Une action oubliée par le code n'est pas tracée ([ADR-011](docs/architecture/adr/011-outbox-et-audit.md))                                                                     |
| Invitations                 | Pour l'adresse invitée seulement, usage unique (même acceptée 5 fois en même temps), ancien lien refusé après retrait, seule l'empreinte du jeton est stockée                                                                                                                                                                                                                                                                                                                           | Envoi par e-mail : le lien est remis à l'administrateur                                                                                                                       |
| Isolation entre entreprises | **Row-Level Security** avec un rôle non propriétaire : requête sans filtre limitée à l'entreprise, écriture pour une autre refusée, contexte qui ne survit pas à sa transaction, clés composites contre les références croisées ; en HTTP : désigner une entreprise dont on n'est pas membre répond 404 ; une personne ne peut pas modifier sa propre adhésion depuis son seul contexte                                                                                                 | Audit de sécurité externe                                                                                                                                                     |
| Catalogue                   | SKU et codes d'entrepôt uniques par entreprise (deux entreprises peuvent utiliser le même) ; pagination par curseur sans doublon ni oubli ; un produit refusé ne laisse aucune trace                                                                                                                                                                                                                                                                                                    |                                                                                                                                                                               |
| Garde-fous                  | **Quarante-six garde-fous cassés volontairement** : 8 à l'incrément 1, 9 au 2, 14 au 3, 9 au 4, 6 au 5 (masquage dans les journaux, paramètres d'URL, identifiant de corrélation, métriques par gabarit, erreurs et événements comptés) : quarante-quatre font échouer un test ; les deux autres sont redondants avec d'autres protections, et c'est documenté ([ADR-009](docs/architecture/adr/009-roles-et-permissions.md), [ADR-014](docs/architecture/adr/014-observabilite.md))    |                                                                                                                                                                               |
| Erreurs, migrations         | Problem Details (RFC 9457) partout ; la CI vérifie que la base migrée correspond au schéma Prisma                                                                                                                                                                                                                                                                                                                                                                                       |                                                                                                                                                                               |
| Observabilité               | Journaux JSON sans secret ni paramètre d'URL, identifiant de corrélation contrôlé ; métriques par gabarit de route, erreurs du domaine, commandes, paiements, événements, **retard de l'outbox** ; alertes testées par `promtool` ; dans la CI, Prometheus lit l'API et le worker construits et Grafana affiche le tableau de bord                                                                                                                                                      | Seuils d'alerte à recaler sur la production ; pas de traces distribuées ([ADR-014](docs/architecture/adr/014-observabilite.md))                                               |
| Charge                      | Rafale de 200 acheteurs pour 50 unités : exactement 50 réservations ; parcours complet jusqu'à 100 vendeurs sans erreur, worker à jour ensuite ; rejoués en court dans la CI                                                                                                                                                                                                                                                                                                            | Plusieurs instances, infrastructure réelle (incrément 6)                                                                                                                      |
| Chaîne d'approvisionnement  | Audit npm **bloquant** en production (une vulnérabilité élevée trouvée et corrigée), signatures du registre, SBOM CycloneDX, licences (copyleft fort refusé), actions GitHub épinglées par empreinte, secrets dans tout l'historique (gitleaks), CodeQL, Dependabot avec délai de deux semaines                                                                                                                                                                                         | Une vulnérabilité élevée de l'outillage de développement acceptée et datée ([ADR-015](docs/architecture/adr/015-chaine-d-approvisionnement.md)) ; images Docker (incrément 6) |

**167 tests automatisés** contre PostgreSQL, Redis et SMTP réels : 33 sur le moteur de stock, 4 sur les règles d'adhésion, 2 sur le hachage des mots de passe, 13 sur les règles des commandes, 6 sur l'outbox, 4 sur les règles des expéditions, 2 sur les messages, 3 sur les journaux, 78 sur l'API en HTTP, 7 sur le worker, 3 sur le front (Vitest) et **12 dans un navigateur** (Cypress) ; plus les tests des alertes (`promtool`) et deux scénarios k6.

## Architecture

```
apps/web          front Angular 22 (composants autonomes, signaux) : connexion, stock, commandes, expéditions, journal
apps/web-e2e      tests de bout en bout Cypress
apps/api          API REST NestJS (/api/v1) : garde d'accès global, erreurs Problem Details
apps/worker       NestJS sans HTTP : expiration des réservations (BullMQ), balayage toutes les 30 s,
                  relais de l'outbox, consommateur des événements (annulation, expédition, e-mails)
libs/identity     comptes, mots de passe (Argon2id borné), jetons d'accès, renouvellement à rotation
libs/tenancy      entreprises, adhésions, invitations, rôles et permissions
libs/catalog      produits, variantes, entrepôts
libs/inventory    moteur de stock : réserver, confirmer, libérer, expirer ; planificateur BullMQ
libs/orders       commandes, Idempotency-Key, paiement (notification signée), compensation
libs/messaging    outbox transactionnelle, relais vers BullMQ, messages déjà traités
libs/audit        journal d'audit (écriture dans la transaction de l'action, lecture)
libs/shipping     expéditions : création à la confirmation, expédier, livrer
libs/notifications  e-mails aux clients : enregistrés, puis envoyés par SMTP hors transaction
libs/observability  journaux JSON (pino), métriques Prometheus sur un port séparé
libs/database     client Prisma (rôle applicatif) et TenantDatabase : une transaction, un contexte
libs/testing      bases réelles pour les tests, données de test
prisma/           schéma, migrations (CHECK, RLS, déclencheurs, fonctions), données de démonstration
infrastructure/   Prometheus (alertes et leurs tests), Grafana (tableau de bord provisionné)
tests/load/       tests de charge k6 et résultats de référence
infrastructure/aws/  amorçage (CloudFormation : OIDC, état, ECR) et Terraform (ECS, RDS, ElastiCache, CloudFront)
Dockerfile        image de l'API et du worker, image de migration
docs/exploitation/   déploiement, retour arrière, pannes provoquées, restauration
```

```
requête ──► garde : jeton valide ? membre de l'entreprise X-Tenant-Id (relu en base) ? permission du rôle ?
              │
              ▼
          TenantDatabase.runAs({ entreprise, utilisateur }) ──► transaction : set_config(…, true)
              │  UPDATE … WHERE disponible >= quantité RETURNING
              ▼
          PostgreSQL (RLS, CHECK, clés composites, déclencheurs)
 │  job différé « expire-<réservation> »
 ▼
Redis / BullMQ ──► worker ──► expire si encore active ET échue en base ; balayage des oubliés
```

Monolithe modulaire ([ADR-001](docs/architecture/adr/001-monolithe-modulaire-nx.md)) : l'API et le worker partagent les modules, mais tournent dans deux processus. La vision complète est dans [docs/architecture/vision.md](docs/architecture/vision.md), les décisions dans [les ADR](docs/architecture/adr/README.md).

## Démarrer

Prérequis : Node.js 24, Docker.

```bash
npm ci                                   # génère aussi le client Prisma
docker compose up -d                     # PostgreSQL 18 (5437), Redis 8 (6380), Mailpit (8025), en mémoire
cp .env.example .env                     # adresses locales, secret de développement
export DATABASE_URL=postgresql://stockpilot:stockpilot@127.0.0.1:5437/stockpilot
npx prisma migrate deploy
npm run db:seed                          # Atelier Nova : demo@ (propriétaire), entrepot@, lecture@
                                         # (@atelier-nova.example), mot de passe demonstration-stockpilot

npx nx serve api                         # http://localhost:3000/api/v1
npx nx serve worker                      # e-mails visibles sur http://localhost:8025 (Mailpit)
(cd apps/web && npx ng serve)           # front : http://localhost:4200
docker compose --profile observabilite up -d   # Prometheus :9090, Grafana :3001 (métriques : METRICS_PORT=9464 pour l'API)
node scripts/demo-concurrence.mjs        # connexion, puis 20 commandes pour 5 casques
PAYMENT_WEBHOOK_SECRET=… node scripts/demo-commande.mjs   # commande, paiement signé, refus, expiration
                                         # (scénario d'expiration : RESERVATION_TTL_SECONDS court)
```

Deux rôles PostgreSQL : `stockpilot` possède les tables et sert aux migrations ; `stockpilot_app` sert à l'application et ne peut pas contourner la Row-Level Security.

## API

```
POST   /api/v1/auth/register | login         compte, entreprise et adhésion de propriétaire ; jeton d'accès + cookie
POST   /api/v1/auth/refresh | logout         renouvellement à rotation, déconnexion (en-tête X-Requested-With)
GET    /api/v1/auth/me                       le compte et ses entreprises, avec le rôle dans chacune
POST   /api/v1/auth/tenants                  une entreprise de plus
GET    /api/v1/members                       membres de l'entreprise
PATCH  /api/v1/members/:userId               changer un rôle
DELETE /api/v1/members/:userId               retirer un membre, ou se retirer soi-même
POST   /api/v1/invitations                   inviter (jeton montré une fois) ; POST /invitations/accept pour accepter
GET    /api/v1/products ; POST /products     catalogue, pagination par curseur, recherche
POST   /api/v1/products/:id/variants
GET    /api/v1/warehouses ; POST /warehouses
GET    /api/v1/inventory?warehouseId=        stock par ligne : physique, réservé, disponible
POST   /api/v1/inventory/receipts            entrée de marchandise (mouvement tracé)
POST   /api/v1/reservations                  201, 200 si la référence avait déjà réservé, 409 si stock insuffisant
POST   /api/v1/reservations/:id/confirm | release
POST   /api/v1/orders                        Idempotency-Key obligatoire ; 201 (rejouée : Idempotent-Replayed), 409, 422
GET    /api/v1/orders ; GET /orders/:id      commandes, avec paiement et historique des statuts
POST   /api/v1/orders/:id/cancel             annulation (la réservation est rendue)
POST   /api/v1/payments/webhook              notification du prestataire (en-tête Stockpilot-Signature), sans jeton
GET    /api/v1/audit                         journal d'audit (propriétaire, administrateur)
GET    /api/v1/shipments ; GET /shipments/:id  expéditions (créées par le worker à la confirmation)
POST   /api/v1/shipments/:id/ship | deliver  expédier (transporteur, suivi), livrer
GET    /api/v1/notifications                 e-mails envoyés aux clients (propriétaire, administrateur)
```

Les routes d'entreprise demandent `Authorization: Bearer …` et `X-Tenant-Id` (l'entreprise choisie parmi celles de l'utilisateur).

## Tests

```bash
npx nx run-many -t lint typecheck build
npx nx run-many -t test --parallel=1     # Testcontainers démarre PostgreSQL et Redis
```

Tests navigateur, une fois l'API, le worker et le front démarrés (voir [Démarrer](#démarrer)) :

```bash
cd apps/web-e2e && PAYMENT_WEBHOOK_SECRET=… npx cypress run   # MAILPIT_URL=http://127.0.0.1:8025 pour vérifier aussi la boîte
```

Tests de charge (k6), contre l'API et le worker construits :

```bash
k6 run tests/load/contention.js                                  # exactitude sous rafale
PAYMENT_WEBHOOK_SECRET=… VUS=100 k6 run tests/load/parcours.js   # latences et débit
```

Pour réutiliser les services de `docker compose` : `STOCKPILOT_TEST_DATABASE_URL` (rôle `stockpilot`), `STOCKPILOT_TEST_APP_DATABASE_URL` (rôle `stockpilot_app`) et `STOCKPILOT_TEST_REDIS_URL`.

## Feuille de route

| Incrément | Contenu                                                                                                                                                                                   | État                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1         | Socle Nx, PostgreSQL et Redis, Prisma et migrations, moteur de stock (réservation atomique, confirmation, expiration BullMQ, RLS), API et worker, tests de concurrence et d'isolation, CI | **fait**                                                       |
| 2         | Identité (JWT, renouvellement à rotation, Argon2id), entreprises, membres, invitations, rôles et permissions ; catalogue et entrepôts                                                     | **fait**                                                       |
| 3         | Commandes, Idempotency-Key, paiement simulé, outbox, compensation, audit                                                                                                                  | **fait**                                                       |
| 4         | Expéditions, notifications, front Angular, tests Cypress                                                                                                                                  | **fait**                                                       |
| 5         | Observabilité, tests de charge k6, sécurité de la chaîne (scans, SBOM)                                                                                                                    | **fait**                                                       |
| 6         | Terraform AWS, **déploiement réel**, panne provoquée, restauration et retour arrière documentés                                                                                           | **en cours** : infrastructure prête, exécution sur AWS à venir |

## Limites actuelles

- Une instance de l'API plafonne vers 100 à 125 req/s sur un poste de développement (un cœur) : la montée en charge passe par plusieurs instances (incrément 6).

- E-mails aux clients seulement : ni vérification d'adresse, ni réinitialisation de mot de passe, ni envoi des invitations (le lien est remis à l'administrateur).
- Limite de débit en mémoire d'une instance : à partager (Redis) quand l'API aura plusieurs instances.
- Expiration au pire « échéance + 30 s » si un job est perdu ([ADR-006](docs/architecture/adr/006-expiration-bullmq.md)).
- Paiement simulé : le format de notification est celui de StockPilot, pas celui d'un prestataire réel ; le remboursement est exigé (statut, audit, événement) mais pas exécuté.
- Pas de purge : clés d'idempotence, outbox et messages traités grandissent sans fin (à ajouter avec les tâches périodiques).
- Le front est servi par `ng serve` ; sa mise en ligne (fichiers statiques sur le domaine de l'API) vient avec le déploiement (incrément 6).
