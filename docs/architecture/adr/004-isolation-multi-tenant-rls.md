# ADR-004 : isolation entre entreprises par la base (clés composites et Row-Level Security)

**État** : acceptée ; l'entreprise est encore lue dans un en-tête provisoire (`X-Tenant-Id`) jusqu'à l'authentification (incrément 2).

## Contexte

Une donnée d'une entreprise ne doit jamais être visible ni modifiable par une autre. Un filtre `tenant_id` dans chaque requête suffit tant que personne ne l'oublie ; il faut une défense qui tienne même quand le code se trompe.

## Décision

Quatre niveaux :

1. **Contexte** : l'entreprise vient du contexte de la requête (en-tête provisoire, puis jeton), jamais du corps.
2. **Clés étrangères composites** `(tenant_id, id)` : une ligne de stock ne peut pas référencer l'entrepôt ou l'article d'une autre entreprise, même par une requête directe.
3. **Row-Level Security** sur toutes les tables métier, `FORCE` compris, avec une politique qui compare `tenant_id` à l'entreprise du contexte. L'application se connecte avec `stockpilot_app`, membre de `stockpilot_runtime` : ni propriétaire des tables, ni `BYPASSRLS`. Les migrations utilisent le rôle propriétaire.
4. **Contexte par transaction** : `TenantDatabase.run()` ouvre une transaction et y pose `set_config('app.tenant_id', …, true)`. Le réglage disparaît au COMMIT : une connexion rendue au pool ne garde jamais l'entreprise précédente. Sans contexte, aucune ligne n'est visible.

Le worker doit trouver les réservations expirées de toutes les entreprises : une fonction `SECURITY DEFINER` (`expired_reservations`) ne lui révèle que l'identifiant et l'entreprise ; chaque expiration se fait ensuite dans le contexte de son entreprise.

## Conséquences

- Une ressource d'une autre entreprise répond 404 (introuvable), jamais 403 : on ne confirme pas son existence.
- Toute requête de l'application passe par une transaction, même une lecture : coût faible, à mesurer par les tests de charge.
- Testé : requête sans filtre, écriture pour une autre entreprise, référence croisée par clé composite, contexte qui survivrait à sa transaction (la variante `set_config(…, false)` est détectée par un test), identifiant mal formé.
- L'en-tête `X-Tenant-Id` sans authentification n'est pas une sécurité : il disparaît à l'incrément 2. La RLS, elle, ne changera pas.
