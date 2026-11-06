# ADR-008 : comptes et sessions (jeton d'accès court, renouvellement à rotation)

**État** : acceptée.

## Contexte

Le front Angular doit garder l'utilisateur connecté sans exposer à une faille XSS un jeton longue durée, et une session volée doit pouvoir être détectée et coupée. L'API est seule à émettre et à vérifier ses jetons.

## Décision

- **Mots de passe** : Argon2id (64 Mio, 3 passes), 12 caractères au moins. Le calcul a lieu dans le pool de fils de Node et au plus `cpu/2` à la fois : sans cette borne, une rafale de connexions gèle l'API et réclame 64 Mio par requête (constaté sur un projet précédent). Un e-mail inconnu est comparé à une empreinte factice : même temps de réponse, même message qu'un mauvais mot de passe.
- **Jeton d'accès** : JWT HS256 de 15 minutes, qui ne dit que « qui » (`sub`). L'entreprise et le rôle ne sont pas dedans : ils sont relus en base à chaque requête ([ADR-009](009-roles-et-permissions.md)). HS256 suffit tant que l'API est seule à vérifier ; un second service vérificateur imposerait une clé asymétrique.
- **Jeton de renouvellement** : 32 octets aléatoires, dont seule l'empreinte SHA-256 est stockée, dans un cookie `HttpOnly`, `SameSite=Strict`, `Secure` en production, limité au chemin `/api/v1/auth`. Chaque usage le remplace (même famille, nouveau jeton). Un jeton **déjà échangé** et présenté de nouveau signale un vol probable : toute la famille est révoquée, l'utilisateur légitime compris.
- **CSRF** : les routes qui lisent ce cookie exigent l'en-tête `X-Requested-With: StockPilot`, qu'un formulaire d'un autre site ne peut pas poser.
- **Limite de débit** : inscription et connexion limitées par adresse IP (10 par minute par défaut), en mémoire du processus.

## Conséquences

- Deux onglets qui renouvellent au même instant présentent le même jeton : le second est traité comme un rejeu et la session tombe. Dans un même onglet, le front sérialise ses renouvellements ([ADR-013](013-front-angular-et-cypress.md)) ; entre deux onglets, le risque demeure.
- La limite de débit est par instance : avec plusieurs API, il faudra la partager (Redis).
- Pas d'e-mail : pas de vérification d'adresse ni de réinitialisation de mot de passe pour l'instant.
- Testé : cookie et ses attributs, rotation, rejeu qui révoque la famille, en-tête anti-CSRF, déconnexion, jeton falsifié ou expiré, limite de débit ; la suppression de chacune de ces protections fait échouer un test.
