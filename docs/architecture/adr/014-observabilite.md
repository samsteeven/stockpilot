# ADR-014 : observabilité par journaux JSON corrélés et métriques Prometheus, sans traces distribuées

**État** : acceptée.

## Contexte

Une commande traverse l'API, la base, l'outbox, Redis, le worker, un serveur SMTP et le prestataire de paiement. Quand un client dit « je n'ai jamais reçu ma confirmation », il faut retrouver ce qui s'est passé ; quand l'outbox prend du retard, il faut le savoir avant les clients. Les journaux actuels (texte de Nest) ne se cherchent pas, et rien ne mesurait les traitements asynchrones.

## Options étudiées

- **OpenTelemetry complet (traces, métriques, journaux)** : déjà fait en profondeur dans deux projets précédents ; ici, une trace ne suivrait pas naturellement le passage par l'outbox (écriture, puis publication plus tard par un autre processus) sans propager le contexte dans chaque événement.
- **Journaux JSON corrélés + métriques Prometheus**, avec l'identifiant de la commande comme fil conducteur entre API et worker (il est déjà la `correlationId` de chaque événement).

## Décision

- **Journaux JSON** (pino, via nestjs-pino) dans l'API et le worker, une ligne par événement, avec `service`. Chaque requête HTTP porte un **X-Request-Id** (repris s'il est sûr, créé sinon, renvoyé au client), l'entreprise, l'utilisateur, la route **sans paramètres de requête** (une recherche ou un e-mail n'entre pas dans les journaux), le code et la durée. Niveau `warn` pour une 4xx, `error` pour une 5xx. Les en-têtes ne sont pas journalisés ; jeton, cookies et signature du prestataire sont en plus masqués par pino.
- **Métriques Prometheus** sur un **port séparé** (9464 pour l'API, 9465 pour le worker), jamais derrière le répartiteur de charge public :
  - durée des requêtes par **gabarit de route** (`/api/v1/orders/:id`, pas une série par identifiant) et code ;
  - erreurs du domaine par titre (stock insuffisant, clé réutilisée, signature refusée…) ;
  - commandes créées ou rejouées, notifications de paiement par issue ;
  - événements traités par type et issue, échecs rejoués ;
  - **retard de l'outbox** (nombre en attente, âge du plus ancien, lu par une fonction `SECURITY DEFINER` qui n'en révèle que ces deux nombres) et jobs par file et état, relevés toutes les 5 s ;
  - métriques du processus Node (boucle d'événements, mémoire).
- **Alertes** (Prometheus) : processus muet, plus de 2 % de 5xx, p95 au-dessus de 500 ms, outbox en retard de plus d'une minute, événements en échec répétés, jobs en échec définitif, signatures refusées en série. Chaque alerte dit quoi regarder ; chacune est **testée** (`promtool test rules`). Un tableau de bord Grafana est provisionné depuis le dépôt.

## Conséquences

- Pas de vue « une requête, toutes ses étapes » comme le donnerait une trace. On suit une commande par son identifiant dans les journaux de l'API et du worker ; si cela ne suffit plus (plus de services, latences à décomposer), propager le contexte W3C dans les événements de l'outbox est le chemin prévu.
- Les compteurs vivent en mémoire de chaque processus : un redémarrage les remet à zéro (normal pour Prometheus, qui calcule des taux).
- En production (incrément 6) : journaux vers CloudWatch, métriques lues par un Prometheus géré ou l'agent CloudWatch ; les seuils seront recalés sur les mesures réelles.
- Testé : journaux d'une vraie requête (aucun secret, pas de paramètres d'URL, identifiant de corrélation contrôlé), métriques de l'API par gabarit de route, commandes créées et rejouées, erreurs comptées, port séparé ; dans le worker : événements comptés, outbox et files mesurées ; dans la CI, chaîne complète Prometheus et Grafana sur l'application construite et tests des alertes. Six garde-fous cassés volontairement : cinq détectés ; le masquage de l'en-tête `Authorization` est redondant avec le sérialiseur, qui n'écrit aucun en-tête, et reste en défense en profondeur.
