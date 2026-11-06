# StockPilot : vision et architecture cible

Plateforme SaaS B2B de gestion des stocks, des commandes et des expéditions, multi-entreprises (multi-tenant). Ce document condense le blueprint de départ (douze semaines, niveau avancé) et les décisions prises en le mettant en œuvre. Le dépôt avance par incréments ; le README dit ce qui est fait et vérifié.

## Le problème

Une entreprise gère plusieurs entrepôts (Paris, Lyon, Bordeaux), ses produits, ses niveaux de stock, ses commandes et ses expéditions. Le scénario central :

1. un client commande 10 unités ;
2. StockPilot choisit l'entrepôt, vérifie le disponible et **réserve les 10 unités de façon atomique** ;
3. la commande attend le paiement (simulé ou confirmé par un prestataire) ;
4. la réservation devient une sortie définitive, une expédition est créée, le client est prévenu ;
5. si le paiement n'arrive pas, la réservation **expire** et le stock revient.

Le défi : si deux clients commandent en même temps les dernières unités, StockPilot ne doit **jamais vendre plus qu'il n'a**. La valeur du projet tient à cette cohérence sous concurrence, à l'isolation entre entreprises et à la fiabilité des traitements asynchrones, pas au nombre d'écrans.

## Périmètre

Identity (authentification, sessions, rôles), Tenants (entreprises, membres, invitations, isolation), Catalog (produits, variantes, SKU), Warehouses (entrepôts, emplacements), Inventory (quantités, mouvements, ajustements, transferts), Reservations (réservation temporaire, expiration, libération), Orders, Payments (simulé), Shipping, Notifications, Analytics, Audit. Pas un ERP : le cœur est le flux stock → réservation → commande → expédition.

## Invariants métier

1. Le stock physique n'est jamais négatif.
2. Le stock réservé ne dépasse jamais le stock physique.
3. Une réservation n'est confirmée ou libérée qu'une seule fois ; confirmation et expiration simultanées ne laissent qu'un état final.
4. Une commande confirmée ne se modifie plus librement.
5. Un mouvement de stock validé est immuable : on le corrige par un mouvement compensatoire.
6. Un utilisateur n'accède qu'aux ressources de son entreprise.
7. Pas d'expédition pour une commande annulée.

## Architecture

- **Monolithe modulaire** (Nx) : une API et un worker, processus et conteneurs distincts, qui partagent les mêmes modules métier. Les modules communiquent par contrats publics, jamais par les tables d'un autre domaine.
- **PostgreSQL source de vérité**, Prisma comme adaptateur de persistance ; les règles critiques (quantités, isolation, immuabilité) sont aussi des contraintes de la base.
- **Concurrence sur le stock** : mise à jour conditionnelle atomique (`… WHERE on_hand - reserved >= q RETURNING`), lignes traitées dans un ordre déterministe, tout ou rien par transaction.
- **Isolation multi-tenant en profondeur** : tenant tiré du contexte authentifié, dépôts qui filtrent, clés étrangères composites (une ressource ne peut pas en référencer une d'une autre entreprise), et **Row-Level Security** PostgreSQL avec un rôle applicatif non propriétaire et un contexte posé par transaction (`set_config(…, true)`), jamais conservé par une connexion du pool.
- **Asynchrone** : Redis + BullMQ pour les tâches (expiration, notifications), outbox PostgreSQL pour les événements. BullMQ n'est jamais la source de vérité : un job retardé ou rejoué recontrôle l'état en base.
- **Idempotence** : `Idempotency-Key` sur les commandes, référence unique par réservation, messages traités enregistrés.
- **Front Angular**, API REST `/api/v1` documentée en OpenAPI.
- **AWS** : ECS Fargate (API, worker), RDS PostgreSQL, ElastiCache Redis, S3 + CloudFront (front), Secrets Manager, KMS, CloudWatch ; Terraform ; **déploiement réel** prévu en fin de projet.

## Décisions prises en partant du blueprint

| Sujet            | Blueprint        | Retenu      | Pourquoi                                                                                           |
| ---------------- | ---------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| Front            | Vue 3            | **Angular** | Vue est déjà dans d'autres projets du portfolio ; beaucoup d'offres NestJS l'associent à Angular   |
| Tests navigateur | Playwright       | **Cypress** | Playwright est déjà dans d'autres projets ; Cypress est demandé par une partie des offres          |
| NestJS           | dernière version | **11**      | Nx 24 n'accepte pas encore NestJS 12                                                               |
| TypeScript       | non précisé      | **6.0**     | Angular 22 et la CLI Nest exigent TypeScript 6.0 ; TypeScript 7 n'expose plus l'API de compilation |
| Prisma           | non précisé      | **7.10.1**  | la version « latest » publiée est une pré-version 8                                                |

Ce qui est déjà démontré ailleurs dans le portfolio (outbox complète, webhooks signés, traces distribuées) n'est repris ici qu'au niveau utile ; l'effort porte sur la concurrence, l'isolation par la base, l'idempotence et l'exploitation cloud réelle.

## Incréments prévus

| #   | Contenu                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Socle Nx (API, worker), PostgreSQL et Redis, Prisma et migrations, moteur de stock : réservation atomique, confirmation, expiration par BullMQ, RLS ; tests de concurrence et d'isolation contre de vraies bases ; CI |
| 2   | Identité (JWT, renouvellement à rotation, Argon2id), entreprises, membres, invitations, RBAC ; catalogue et entrepôts ; tests d'isolation par l'API                                                                   |
| 3   | Commandes, Idempotency-Key, paiement simulé, outbox, compensation, historique et audit                                                                                                                                |
| 4   | Expéditions, notifications, front Angular, tests Cypress                                                                                                                                                              |
| 5   | Observabilité, tests de charge k6 (dont 20 commandes pour 5 unités), sécurité de la chaîne (scans, SBOM)                                                                                                              |
| 6   | Terraform AWS, déploiement réel, panne provoquée, restauration, retour arrière documenté                                                                                                                              |

## Critères non négociables

Aucune survente quel que soit le scénario concurrent ; aucune donnée d'une entreprise visible par une autre ; un message dupliqué, un worker redémarré ou un job retardé ne corrompt pas l'état ; frontières de modules documentées ; sécurité testée, pas seulement décrite ; environnement cloud reproductible et restaurable.
