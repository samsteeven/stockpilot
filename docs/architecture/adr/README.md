# Décisions d'architecture

Chaque ADR dit le contexte, les options étudiées, la décision, ses conséquences, et ce qui conduirait à la revoir.

| ADR                                          | Décision                                                                                                                            | État                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| [001](001-monolithe-modulaire-nx.md)         | Monolithe modulaire Nx : une API et un worker qui partagent les modules métier                                                      | acceptée, appliquée |
| [002](002-postgresql-source-de-verite.md)    | PostgreSQL source de vérité ; les invariants critiques sont aussi des contraintes de la base                                        | acceptée, appliquée |
| [003](003-prisma-et-versions.md)             | Prisma 7 comme adaptateur de persistance ; versions retenues (NestJS 11, TypeScript 6.0)                                            | acceptée, appliquée |
| [004](004-isolation-multi-tenant-rls.md)     | Isolation entre entreprises : clés composites et Row-Level Security avec contexte par transaction                                   | acceptée, appliquée |
| [005](005-reservation-atomique.md)           | Réservation atomique par mise à jour conditionnelle, ordre de verrouillage fixe, un seul état final                                 | acceptée, appliquée |
| [006](006-expiration-bullmq.md)              | Expiration par job BullMQ différé, recontrôlée en base, et balayage périodique                                                      | acceptée, appliquée |
| [007](007-tests-contre-vraies-bases.md)      | Tests contre PostgreSQL et Redis réels, courses rejouées, garde-fous cassés volontairement                                          | acceptée, appliquée |
| [008](008-comptes-et-sessions.md)            | Comptes et sessions : Argon2id borné, jeton d'accès court, renouvellement à rotation et détection de rejeu                          | acceptée, appliquée |
| [009](009-roles-et-permissions.md)           | Entreprises, membres, permissions : adhésion relue à chaque requête, dernier propriétaire protégé par la base                       | acceptée, appliquée |
| [010](010-commandes-idempotence-paiement.md) | Commandes : Idempotency-Key dans la transaction, prix du catalogue, paiement par notification signée, compensation                  | acceptée, appliquée |
| [011](011-outbox-et-audit.md)                | Outbox transactionnelle, consommateurs idempotents, journal d'audit en ajout seulement                                              | acceptée, appliquée |
| [012](012-expeditions-et-notifications.md)   | Expéditions créées par le worker, messages aux clients enregistrés puis envoyés hors transaction                                    | acceptée, appliquée |
| [013](013-front-angular-et-cypress.md)       | Front Angular autonome dans le monorepo, session en mémoire et renouvellement unique, tests Cypress                                 | acceptée, appliquée |
| [014](014-observabilite.md)                  | Journaux JSON corrélés et métriques Prometheus sur un port séparé, alertes testées, pas de traces distribuées                       | acceptée, appliquée |
| [015](015-chaine-d-approvisionnement.md)     | Chaîne d'approvisionnement : versions mûres, signatures, audit bloquant en production, SBOM et licences, actions épinglées, secrets | acceptée, appliquée |
