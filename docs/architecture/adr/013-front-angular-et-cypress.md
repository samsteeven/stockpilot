# ADR-013 : front Angular autonome dans le monorepo, tests de bout en bout Cypress

**État** : acceptée.

## Contexte

Le front doit montrer le métier (stock, commandes, expéditions, journal) à chaque rôle, sans affaiblir la sécurité des sessions ([ADR-008](008-comptes-et-sessions.md)). Le monorepo Nx utilise des références de projets TypeScript ; le plugin Nx pour Angular refuse cette configuration (Angular ne prend pas en charge les références de projets).

## Options étudiées

- Désactiver la vérification du plugin (`NX_IGNORE_UNSUPPORTED_TS_SETUP`) : configuration non prise en charge, à nos risques.
- Revenir à des chemins TypeScript (`paths`) pour tout le dépôt : casse la configuration des bibliothèques serveur, qui fonctionne.
- **Application Angular CLI autonome dans `apps/web`**, avec sa propre configuration TypeScript, que Nx exécute par ses scripts npm (`build`, `test`, `typecheck`).

## Décision

- **Angular 22** (composants autonomes, signaux, sans zone.js), application CLI autonome dans `apps/web`. Le front n'importe pas les bibliothèques serveur : il ne connaît que l'API HTTP (types décrits dans `core/models.ts`).
- **Session** : jeton d'accès en mémoire seulement (ni `localStorage` ni `sessionStorage`) ; au rechargement, la session est retrouvée par le cookie de renouvellement `HttpOnly`. Un intercepteur ajoute le jeton et l'entreprise, et sur un 401 renouvelle **une seule fois pour toutes les requêtes en attente** (promesse partagée) puis les rejoue : c'était la limite notée dans l'ADR-008 (deux renouvellements simultanés passent pour un vol).
- **Permissions** : `GET /auth/me` donne, pour chaque entreprise, les permissions du rôle ; le front n'affiche que les actions possibles. C'est du confort : l'API vérifie chaque requête.
- **Idempotency-Key** : générée par le formulaire de commande et gardée tant que la commande n'a pas abouti ; un double clic ou un nouvel essai après une coupure réseau retrouve la même commande. Une erreur 4xx (rien n'a été créé) donne une clé neuve.
- **Tests** : Vitest pour l'intercepteur et la session ; **Cypress** (`apps/web-e2e`) contre l'application réelle (front, API et worker construits, PostgreSQL, Redis, Mailpit), le prestataire de paiement étant joué par les tests (notifications signées par une tâche Node : le secret ne passe pas dans le navigateur).

## Conséquences

- Pas de générateurs Nx pour le front ; `ng` s'utilise dans `apps/web`. Si le plugin Angular prend en charge les références de projets, l'application pourra y être rattachée sans changer son code.
- Le front est servi par `ng serve` (mandataire vers l'API) en développement et dans la CI ; en production (incrément 6), fichiers statiques derrière le même domaine que l'API, pour garder le cookie `SameSite=Strict`.
- Pas d'ESLint propre à Angular (règles de gabarits) pour l'instant : format Prettier, types stricts et tests.
- Testé dans un navigateur : connexion refusée, page protégée, session qui survit au rechargement, cookie `HttpOnly`, aucun jeton dans le stockage du navigateur, renouvellement transparent après un 401, commande créée puis annulée (stock réservé puis rendu), double soumission (une seule commande), stock insuffisant, parcours payé → expédition créée par le worker → expédiée et livrée par le responsable d'entrepôt → trois messages au client, ce que voient le lecteur, le responsable d'entrepôt et le propriétaire.
