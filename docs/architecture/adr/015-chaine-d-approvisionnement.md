# ADR-015 : sécurité de la chaîne d'approvisionnement

**État** : acceptée.

## Contexte

StockPilot dépend d'environ 2 000 paquets npm (300 livrés en production), d'actions GitHub et d'images Docker. Un paquet compromis, une action dont l'étiquette est déplacée vers du code malveillant ou une vulnérabilité connue dans une dépendance touchent l'application sans qu'une ligne de son code change.

## Décision

- **Versions mûres** : une dépendance nouvelle ou mise à jour est choisie parmi les versions publiées depuis au moins deux semaines (le temps qu'un paquet compromis soit repéré) ; Dependabot applique le même délai (`cooldown`). Exception possible pour un correctif de sécurité, justifiée.
- **Intégrité** : `npm ci` sur un `package-lock.json` versionné ; `npm audit signatures` vérifie les signatures du registre et les attestations de provenance (2 021 paquets signés, 507 attestés au 2026-11-06).
- **Vulnérabilités connues** : `npm audit` bloque la CI pour toute vulnérabilité **élevée ou critique dans les dépendances livrées en production** ; pour l'outillage de développement, seules les critiques bloquent, le reste est signalé.
- **SBOM** CycloneDX des dépendances de production, produit à chaque exécution de la CI et conservé comme artefact ; les **licences** y sont vérifiées : copyleft fort refusé (GPL, AGPL, SSPL…), copyleft faible signalé, licence absente refusée.
- **Actions GitHub épinglées par empreinte de commit** (et non par étiquette, qu'un attaquant peut déplacer), versions lisibles en commentaire ; Dependabot les met à jour.
- **Secrets** : gitleaks parcourt tout l'historique git à chaque exécution ; les valeurs de démonstration, de test et de CI, publiques par nature, sont listées explicitement dans `.gitleaks.toml`.
- **Analyse statique** : CodeQL (requêtes `security-extended`) à chaque push et chaque semaine.
- Les **images Docker** de l'API et du worker, leur analyse et leur SBOM arrivent avec le déploiement (incrément 6).

## Conséquences

- Constat au moment de la décision : `multer` 2.4.0 (via `@nestjs/platform-express`, qui le fixe à cette version exacte) avait une vulnérabilité élevée (déni de service). StockPilot n'accepte pas de fichiers, mais la version est forcée à 2.5.0 par `overrides`, à retirer quand NestJS 11 l'intégrera.
- Vulnérabilité élevée restante dans `vite` 8.3.0, utilisé seulement par le serveur de développement d'Angular (`ng serve`), jamais livré : acceptée jusqu'à la mise à jour de `@angular/build` (22.2.5 ou plus, publiée depuis deux semaines à partir du 2026-11-11). Un `overrides` imbriqué n'est pas appliqué par npm à cette dépendance d'un espace de travail.
- 44 vulnérabilités modérées dans l'outillage (Nx, Jest, Testcontainers) : signalées, suivies par Dependabot, non bloquantes.
- Les règles de version mûre ralentissent l'adoption des nouveautés de deux semaines : c'est voulu.
