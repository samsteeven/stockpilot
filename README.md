# StockPilot : stocks, réservations et commandes pour plusieurs entreprises, sans jamais vendre ce qu'on n'a pas

Plateforme SaaS B2B de gestion des stocks, des commandes et des expéditions, en **NestJS + TypeScript + PostgreSQL** (monorepo **Nx**, **Prisma**, **Redis + BullMQ**), front **Angular** à venir. Une entreprise gère plusieurs entrepôts ; quand deux clients commandent en même temps les dernières unités, une seule commande passe, et les données d'une entreprise restent invisibles pour les autres, **garanti par la base elle-même**.

> **État : incrément 1.** Le moteur de stock : réservation atomique, confirmation, libération, expiration par BullMQ, isolation entre entreprises par Row-Level Security ; API et worker. L'authentification arrive à l'incrément 2 : d'ici là, l'entreprise est lue dans un en-tête **provisoire** `X-Tenant-Id`. Voir [la feuille de route](#feuille-de-route).

## Le cœur : 20 commandes pour 5 unités

```text
$ node scripts/demo-concurrence.mjs
Avant : 5 en stock, 0 réservés, 5 disponibles
20 commandes simultanées en 220 ms : {"201":5,"409":15} (201 = réservé, 409 = stock insuffisant)
Après : 5 en stock, 5 réservés, 0 disponibles
Aucune survente.
```

_Mesuré contre l'API et le worker construits, sur le poste de développement ; rejoué à chaque push par la CI, suivi de l'expiration des réservations par le worker._

La garantie ne vient pas d'une vérification en code (deux requêtes liraient toutes deux « 5 disponibles ») mais d'une mise à jour conditionnelle, et la base refuse de toute façon un réservé supérieur au physique :

```sql
UPDATE stock_items
SET quantity_reserved = quantity_reserved + $quantité, version = version + 1
WHERE id = $ligne AND quantity_on_hand - quantity_reserved >= $quantité
RETURNING id;   -- aucune ligne : stock insuffisant
```

## Ce qui est vérifié, et ce qui ne l'est pas

| Élément                     | Vérifié                                                                                                                                                                                                                                                              | Pas vérifié                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Pas de survente             | 20 réservations simultanées pour 5 unités, **10 tours** : exactement 5 passent ; 2 × 4 pour 5 : une seule ; en HTTP contre les applications construites (CI)                                                                                                         | Sous charge prolongée, sur plusieurs instances de l'API (incrément 5)                                                 |
| Tout ou rien                | Une ligne en défaut annule toute la commande, la réponse liste chaque manque (demandé, disponible)                                                                                                                                                                   |                                                                                                                       |
| Interblocages               | Commandes A+B et B+A simultanées (30) : aucune erreur, ordre de verrouillage fixe                                                                                                                                                                                    | Le test repose sur une probabilité d'interblocage ([ADR-007](docs/architecture/adr/007-tests-contre-vraies-bases.md)) |
| Idempotence                 | La même référence envoyée 10 fois en même temps ne réserve qu'une fois ; rejouée en HTTP, 200 et même réservation                                                                                                                                                    | `Idempotency-Key` sur les commandes (incrément 3)                                                                     |
| Un seul état final          | Confirmation contre libération simultanées (20 tours) : un seul gagnant, stock juste ; confirmer deux fois ne sort le stock qu'une fois ; expiration arrivée trop tôt ou en double sans effet                                                                        |                                                                                                                       |
| Expiration                  | Worker réel sur une vraie file BullMQ : la réservation expire à son échéance ; balayage qui rattrape une réservation dont le job a été perdu                                                                                                                         | Redémarrage de Redis en plein traitement                                                                              |
| Isolation entre entreprises | **Row-Level Security** avec un rôle non propriétaire : une requête sans filtre ne voit que son entreprise ; écrire pour une autre est refusé par la base ; le contexte ne survit pas à sa transaction ; clés composites contre les références croisées ; 404 en HTTP | Authentification et rôles (incrément 2) : l'en-tête `X-Tenant-Id` actuel n'est **pas** une sécurité                   |
| Règles de la base           | Réservé jamais supérieur au physique (CHECK, même par une requête directe) ; mouvements de stock immuables (déclencheur, et aucun droit de modification pour l'application)                                                                                          |                                                                                                                       |
| Garde-fous                  | **Huit garde-fous cassés volontairement** (condition de disponibilité, ordre de verrouillage, conditions d'état, échéance, référence en double, contexte d'entreprise absent ou posé pour la session) : chacun fait échouer au moins un test                         |                                                                                                                       |
| Erreurs                     | Format Problem Details (RFC 9457) : 409 stock insuffisant avec le détail, 404, 422, 400 sur toute entrée invalide ou champ inconnu                                                                                                                                   |                                                                                                                       |
| Migrations                  | La CI vérifie que la base migrée correspond au schéma Prisma                                                                                                                                                                                                         |                                                                                                                       |

**47 tests automatisés** : 33 sur le moteur de stock (PostgreSQL réel, rôle soumis à la RLS), 12 sur l'API en HTTP, 2 sur le worker (PostgreSQL et Redis réels).

## Architecture

```
apps/api        API REST NestJS (/api/v1) : stock, réservations ; erreurs Problem Details
apps/worker     NestJS sans HTTP : expiration des réservations (BullMQ), balayage toutes les 30 s
libs/inventory  moteur de stock : réserver, confirmer, libérer, expirer ; planificateur BullMQ
libs/database   client Prisma (rôle applicatif) et TenantDatabase : une transaction par appel, contexte d'entreprise
libs/testing    bases réelles pour les tests (Testcontainers ou services existants), données de test
prisma/         schéma, migrations (dont les règles SQL : CHECK, RLS, déclencheur), données de démonstration
```

```
API ──► TenantDatabase.run(entreprise) ──► transaction : set_config('app.tenant_id', …, true)
                                               │  UPDATE … WHERE disponible >= quantité RETURNING
                                               ▼
                                         PostgreSQL (RLS, CHECK, clés composites)
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
cp .env.example .env                     # adresses locales
DATABASE_URL=postgresql://stockpilot:stockpilot@127.0.0.1:5437/stockpilot npx prisma migrate deploy
DATABASE_URL=postgresql://stockpilot:stockpilot@127.0.0.1:5437/stockpilot npm run db:seed

npx nx serve api                         # http://localhost:3000/api/v1
npx nx serve worker
node scripts/demo-concurrence.mjs        # 20 commandes pour 5 casques
```

Deux rôles PostgreSQL : `stockpilot` possède les tables et sert aux migrations ; `stockpilot_app` sert à l'application et ne peut pas contourner la Row-Level Security.

## API (incrément 1)

```
GET  /health, /health/ready                    vivant, base joignable
GET  /api/v1/inventory?warehouseId=            stock par ligne : physique, réservé, disponible
POST /api/v1/inventory/receipts                entrée de marchandise (mouvement tracé)
POST /api/v1/reservations                      réserver : 201, 200 si la référence avait déjà réservé, 409 si stock insuffisant
GET  /api/v1/reservations/:id
POST /api/v1/reservations/:id/confirm          la réservation devient une vente
POST /api/v1/reservations/:id/release          annulation : le stock revient
```

Toutes les routes métier demandent l'en-tête `X-Tenant-Id` (provisoire, remplacé par le jeton à l'incrément 2).

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
| 2         | Identité (JWT, renouvellement à rotation, Argon2id), entreprises, membres, invitations, RBAC ; catalogue et entrepôts                                                                     | à faire  |
| 3         | Commandes, Idempotency-Key, paiement simulé, outbox, compensation, audit                                                                                                                  | à faire  |
| 4         | Expéditions, notifications, front Angular, tests Cypress                                                                                                                                  | à faire  |
| 5         | Observabilité, tests de charge k6, sécurité de la chaîne (scans, SBOM)                                                                                                                    | à faire  |
| 6         | Terraform AWS, **déploiement réel**, panne provoquée, restauration et retour arrière documentés                                                                                           | à faire  |

## Limites actuelles

- **Pas d'authentification** : l'entreprise vient d'un en-tête que n'importe qui peut envoyer. La base isole correctement les entreprises entre elles, mais rien ne vérifie encore qui appelle.
- Pas de catalogue ni d'entrepôts par l'API : ils viennent des données de démonstration.
- Expiration au pire « échéance + 30 s » si un job est perdu ([ADR-006](docs/architecture/adr/006-expiration-bullmq.md)).
