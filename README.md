# StockPilot : stocks, réservations et commandes pour plusieurs entreprises, sans jamais vendre ce qu'on n'a pas

Plateforme SaaS B2B de gestion des stocks, des commandes et des expéditions, en **NestJS + TypeScript + PostgreSQL** (monorepo **Nx**, **Prisma**, **Redis + BullMQ**), front **Angular** à venir. Une entreprise gère plusieurs entrepôts ; quand deux clients commandent en même temps les dernières unités, une seule commande passe, et les données d'une entreprise restent invisibles pour les autres, **garanti par la base elle-même**.

> **État : incrément 2.** Comptes et sessions (Argon2id, jeton d'accès court, renouvellement à rotation avec détection de rejeu), entreprises, membres, invitations et rôles ; catalogue et entrepôts. Incrément 1 : le moteur de stock (réservation atomique, confirmation, expiration par BullMQ, Row-Level Security). Voir [la feuille de route](#feuille-de-route).

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

## Ce qui est vérifié, et ce qui ne l'est pas

| Élément                     | Vérifié                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Pas vérifié                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Pas de survente             | 20 réservations simultanées pour 5 unités, **10 tours** : exactement 5 passent ; 2 × 4 pour 5 : une seule ; en HTTP contre les applications construites (CI)                                                                                                                                                                                                                                                                                               | Sous charge prolongée, sur plusieurs instances de l'API (incrément 5)                                                                       |
| Tout ou rien, interblocages | Une ligne en défaut annule toute la commande ; commandes A+B et B+A simultanées sans erreur (ordre de verrouillage fixe)                                                                                                                                                                                                                                                                                                                                   | Le test d'interblocage repose sur une probabilité ([ADR-007](docs/architecture/adr/007-tests-contre-vraies-bases.md))                       |
| Idempotence                 | La même référence envoyée 10 fois en même temps ne réserve qu'une fois ; rejouée en HTTP, 200 et même réservation                                                                                                                                                                                                                                                                                                                                          | `Idempotency-Key` sur les commandes (incrément 3)                                                                                           |
| Un seul état final          | Confirmation contre libération simultanées (20 tours) : un seul gagnant ; confirmer deux fois ne sort le stock qu'une fois ; expiration trop tôt ou en double sans effet                                                                                                                                                                                                                                                                                   |                                                                                                                                             |
| Expiration                  | Worker réel sur une vraie file BullMQ ; balayage qui rattrape une réservation dont le job a été perdu                                                                                                                                                                                                                                                                                                                                                      | Redémarrage de Redis en plein traitement                                                                                                    |
| Sessions                    | Argon2id borné en concurrence ; même réponse pour un e-mail inconnu et un mauvais mot de passe ; cookie `HttpOnly`, `SameSite=Strict`, limité à `/api/v1/auth` ; rotation à chaque renouvellement ; **un jeton rejoué révoque toute la session** ; en-tête anti-CSRF ; jeton falsifié ou expiré refusé ; limite de débit à la connexion (429)                                                                                                              | Deux onglets qui renouvellent au même instant ([ADR-008](docs/architecture/adr/008-comptes-et-sessions.md)) ; vérification d'adresse e-mail |
| Rôles                       | **Matrice entière** (5 rôles × 8 actions) ; un membre retiré perd l'accès à la requête suivante ; un rôle abaissé s'applique tout de suite ; un administrateur ne touche pas aux propriétaires ; le dernier propriétaire ne peut ni partir ni être rétrogradé, même par une requête SQL directe                                                                                                                                                            | Journal d'audit (incrément 3)                                                                                                               |
| Invitations                 | Pour l'adresse invitée seulement, usage unique (même acceptée 5 fois en même temps), ancien lien refusé après retrait, seule l'empreinte du jeton est stockée                                                                                                                                                                                                                                                                                              | Envoi par e-mail : le lien est remis à l'administrateur                                                                                     |
| Isolation entre entreprises | **Row-Level Security** avec un rôle non propriétaire : requête sans filtre limitée à l'entreprise, écriture pour une autre refusée, contexte qui ne survit pas à sa transaction, clés composites contre les références croisées ; en HTTP : désigner une entreprise dont on n'est pas membre répond 404 ; une personne ne peut pas modifier sa propre adhésion depuis son seul contexte                                                                    | Audit de sécurité externe                                                                                                                   |
| Catalogue                   | SKU et codes d'entrepôt uniques par entreprise (deux entreprises peuvent utiliser le même) ; pagination par curseur sans doublon ni oubli ; un produit refusé ne laisse aucune trace                                                                                                                                                                                                                                                                       |                                                                                                                                             |
| Garde-fous                  | **Dix-sept garde-fous cassés volontairement**, huit à l'incrément 1, neuf à l'incrément 2 (permission, adhésion, révocation au rejeu, jeton marqué utilisé, adresse de l'invitation, règles de l'administrateur, limite de débit, en-tête anti-CSRF, usage unique de l'invitation) : seize font échouer un test ; le dernier est redondant avec deux autres protections, et c'est documenté ([ADR-009](docs/architecture/adr/009-roles-et-permissions.md)) |                                                                                                                                             |
| Erreurs, migrations         | Problem Details (RFC 9457) partout ; la CI vérifie que la base migrée correspond au schéma Prisma                                                                                                                                                                                                                                                                                                                                                          |                                                                                                                                             |

**89 tests automatisés** contre PostgreSQL et Redis réels : 33 sur le moteur de stock, 4 sur les règles d'adhésion tenues par la base, 2 sur le hachage des mots de passe, 48 sur l'API en HTTP, 2 sur le worker.

## Architecture

```
apps/api          API REST NestJS (/api/v1) : garde d'accès global, erreurs Problem Details
apps/worker       NestJS sans HTTP : expiration des réservations (BullMQ), balayage toutes les 30 s
libs/identity     comptes, mots de passe (Argon2id borné), jetons d'accès, renouvellement à rotation
libs/tenancy      entreprises, adhésions, invitations, rôles et permissions
libs/catalog      produits, variantes, entrepôts
libs/inventory    moteur de stock : réserver, confirmer, libérer, expirer ; planificateur BullMQ
libs/database     client Prisma (rôle applicatif) et TenantDatabase : une transaction, un contexte
libs/testing      bases réelles pour les tests, données de test
prisma/           schéma, migrations (CHECK, RLS, déclencheurs, fonctions), données de démonstration
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
docker compose up -d                     # PostgreSQL 18 (5437) et Redis 8 (6380), données en mémoire
cp .env.example .env                     # adresses locales, secret de développement
export DATABASE_URL=postgresql://stockpilot:stockpilot@127.0.0.1:5437/stockpilot
npx prisma migrate deploy
npm run db:seed                          # Atelier Nova : demo@atelier-nova.example / demonstration-stockpilot

npx nx serve api                         # http://localhost:3000/api/v1
npx nx serve worker
node scripts/demo-concurrence.mjs        # connexion, puis 20 commandes pour 5 casques
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
```

Les routes d'entreprise demandent `Authorization: Bearer …` et `X-Tenant-Id` (l'entreprise choisie parmi celles de l'utilisateur).

## Tests

```bash
npx nx run-many -t lint typecheck build
npx nx run-many -t test --parallel=1     # Testcontainers démarre PostgreSQL et Redis
```

Pour réutiliser les services de `docker compose` : `STOCKPILOT_TEST_DATABASE_URL` (rôle `stockpilot`), `STOCKPILOT_TEST_APP_DATABASE_URL` (rôle `stockpilot_app`) et `STOCKPILOT_TEST_REDIS_URL`.

## Feuille de route

| Incrément | Contenu                                                                                                                                                                                   | État     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1         | Socle Nx, PostgreSQL et Redis, Prisma et migrations, moteur de stock (réservation atomique, confirmation, expiration BullMQ, RLS), API et worker, tests de concurrence et d'isolation, CI | **fait** |
| 2         | Identité (JWT, renouvellement à rotation, Argon2id), entreprises, membres, invitations, rôles et permissions ; catalogue et entrepôts                                                     | **fait** |
| 3         | Commandes, Idempotency-Key, paiement simulé, outbox, compensation, audit                                                                                                                  | à faire  |
| 4         | Expéditions, notifications, front Angular, tests Cypress                                                                                                                                  | à faire  |
| 5         | Observabilité, tests de charge k6, sécurité de la chaîne (scans, SBOM)                                                                                                                    | à faire  |
| 6         | Terraform AWS, **déploiement réel**, panne provoquée, restauration et retour arrière documentés                                                                                           | à faire  |

## Limites actuelles

- **Pas d'e-mail** : ni vérification d'adresse, ni réinitialisation de mot de passe ; le lien d'invitation est remis à l'administrateur, qui le transmet.
- Limite de débit en mémoire d'une instance : à partager (Redis) quand l'API aura plusieurs instances.
- Expiration au pire « échéance + 30 s » si un job est perdu ([ADR-006](docs/architecture/adr/006-expiration-bullmq.md)).
- Pas de journal d'audit des actions sensibles (incrément 3).
