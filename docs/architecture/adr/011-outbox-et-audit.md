# ADR-011 : outbox transactionnelle, consommateurs idempotents et journal d'audit

**État** : acceptée.

## Contexte

Une réservation expirée doit annuler sa commande ; une commande confirmée devra bientôt déclencher une expédition et une notification (incrément 4). Publier directement dans Redis depuis une transaction pose deux problèmes : la transaction peut être annulée après la publication (événement fantôme), ou Redis peut être indisponible juste après le COMMIT (événement perdu). Par ailleurs, les actions sensibles (rôles, invitations, commandes, paiements) doivent laisser une trace que personne ne peut retoucher.

## Décision

- **Outbox** : un événement est une ligne de `outbox_events`, écrite **dans la transaction du changement qu'il annonce**. Il existe si et seulement si le changement est validé.
- **Relais** : le worker publie les événements en continu dans la file BullMQ `domain-events`. Un lot est pris par une fonction `SECURITY DEFINER` avec `FOR UPDATE SKIP LOCKED` : plusieurs workers se partagent les lignes sans publier deux fois la même. Un événement est marqué publié après l'accord de la file ; un échec est compté (`attempts`, `last_error`) et l'événement repasse au tour suivant, avec une attente croissante si les échecs se répètent.
- **Au moins une fois, effet une fois** : un arrêt entre la publication et son marquage republie l'événement. L'identifiant du job est celui de l'événement (pas de doublon tant que la file le conserve), et chaque consommateur inscrit l'identifiant traité dans `processed_messages` **dans la transaction de son effet** : une seconde livraison ne fait rien.
- **Droits** : l'application ne peut qu'insérer dans l'outbox, dans le contexte de son entreprise (Row-Level Security) ; elle ne peut pas la relire. Le relais passe par les trois fonctions réservées (prendre, marquer publié, marquer en échec).
- **Audit** : `audit_logs` reçoit, dans la transaction de l'action, qui (ou « le système »), quoi, sur quelle ressource, avec quels détails : changement de rôle, retrait, départ, invitation créée et acceptée, commande créée et annulée, paiement accepté, refusé ou à rembourser. Le rôle applicatif n'a que `SELECT` et `INSERT` ; un déclencheur refuse en plus toute modification ou suppression, même au propriétaire des tables. Même règle pour l'historique des statuts de commande. Lecture par `GET /audit`, réservée aux propriétaires et administrateurs (`audit:read`), dans leur seule entreprise.

## Conséquences

- Délai de publication : de l'ordre de `OUTBOX_POLL_MS` (500 ms par défaut) quand l'outbox est vide, sans attente quand elle est pleine. `LISTEN/NOTIFY` réduirait ce délai ; inutile tant que les consommateurs ne sont pas interactifs.
- L'outbox et `processed_messages` grandissent sans fin : une purge des lignes publiées ou traitées depuis plus de 7 jours viendra avec les tâches périodiques.
- L'audit est fait par le code des services : une action oubliée n'est pas tracée. Les déclencheurs garantissent qu'une trace écrite reste intacte, pas qu'elle existe.
- Seul `reservation.expired` a un consommateur pour l'instant ; les autres événements (`order.created`, `order.confirmed`, `order.cancelled`, `payment.refund_required`) attendent les expéditions et les notifications.
- Testé : événement d'une transaction annulée absent, publication unique, échec compté puis rattrapé, deux publicateurs simultanés (40 événements, aucun doublon ; sans le verrou de ligne, le test échoue), outbox illisible par l'application et refusée pour une autre entreprise, message traité une fois par consommateur, événement livré deux fois en même temps qui n'annule qu'une fois, chaîne complète réservation expirée → outbox → file → commande annulée sur un vrai worker, audit et historique non modifiables même par le propriétaire des tables.
