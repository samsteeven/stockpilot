# Décisions d'architecture

Chaque ADR dit le contexte, les options étudiées, la décision, ses conséquences, et ce qui conduirait à la revoir.

| ADR                                       | Décision                                                                                            | État                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [001](001-monolithe-modulaire-nx.md)      | Monolithe modulaire Nx : une API et un worker qui partagent les modules métier                      | acceptée, appliquée                                             |
| [002](002-postgresql-source-de-verite.md) | PostgreSQL source de vérité ; les invariants critiques sont aussi des contraintes de la base        | acceptée, appliquée                                             |
| [003](003-prisma-et-versions.md)          | Prisma 7 comme adaptateur de persistance ; versions retenues (NestJS 11, TypeScript 6.0)            | acceptée, appliquée                                             |
| [004](004-isolation-multi-tenant-rls.md)  | Isolation entre entreprises : clés composites et Row-Level Security avec contexte par transaction   | acceptée, appliquée (entreprise lue dans un en-tête provisoire) |
| [005](005-reservation-atomique.md)        | Réservation atomique par mise à jour conditionnelle, ordre de verrouillage fixe, un seul état final | acceptée, appliquée                                             |
| [006](006-expiration-bullmq.md)           | Expiration par job BullMQ différé, recontrôlée en base, et balayage périodique                      | acceptée, appliquée                                             |
| [007](007-tests-contre-vraies-bases.md)   | Tests contre PostgreSQL et Redis réels, courses rejouées, garde-fous cassés volontairement          | acceptée, appliquée                                             |
