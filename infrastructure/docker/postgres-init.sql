-- Rôles de l'environnement local (exécuté une fois, à la création de la base).
--
-- stockpilot          propriétaire des tables, utilisé par les migrations seulement
-- stockpilot_runtime  rôle de groupe sans connexion : les droits de l'application (accordés par les migrations)
-- stockpilot_app      connexion de l'API et du worker : membre de stockpilot_runtime, ni propriétaire ni BYPASSRLS,
--                     donc soumis à la Row-Level Security
--
-- En production, les mêmes rôles sont créés par l'infrastructure, avec des mots de passe tirés de Secrets Manager.
CREATE ROLE stockpilot_runtime NOLOGIN;
CREATE ROLE stockpilot_app LOGIN PASSWORD 'stockpilot_app' IN ROLE stockpilot_runtime;
