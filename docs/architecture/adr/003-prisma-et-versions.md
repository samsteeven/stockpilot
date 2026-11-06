# ADR-003 : Prisma 7, NestJS 11, TypeScript 6.0

**État** : acceptée.

## Contexte

Le blueprint retient NestJS, Prisma et Nx sans fixer les versions. En novembre 2026 : NestJS 12 vient de sortir, TypeScript 7 (réécrit en Go) est la version publiée par défaut, et l'étiquette « latest » de Prisma pointe vers une pré-version 8.

## Constats

- Le greffon NestJS de Nx 24 exige NestJS < 12.
- Angular 22 et la CLI Nest exigent TypeScript 6.0 : TypeScript 7 n'expose plus l'API de compilation dont ils dépendent.
- Prisma `8.0.0-rc` n'est pas une version stable ; la dernière stable est 7.10.1.

## Décision

NestJS 11, TypeScript 6.0, Prisma 7.10.1 épinglé. Prisma 7 impose un adaptateur de pilote (`@prisma/adapter-pg`) et un client généré dans le projet (`libs/database/src/generated`, régénéré à l'installation, hors dépôt).

Prisma sert aux requêtes courantes ; les opérations où la concurrence compte (réservation, confirmation, expiration) sont écrites en SQL paramétré (`$queryRaw`), parce que la condition « disponible suffisant » et le `RETURNING` sont le cœur de la garantie et doivent rester lisibles.

## Conséquences

- Les imports en `.js` du client généré demandent un résolveur Jest qui retombe sur les sources `.ts`.
- BullMQ 6 ne fournit plus son client Redis : `ioredis` est une dépendance explicite.
- À revoir quand Nx acceptera NestJS 12 et que Prisma 8 sera stable.
