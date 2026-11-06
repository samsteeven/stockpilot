# ADR-006 : expiration des réservations par BullMQ, base comme source de vérité

**État** : acceptée.

## Contexte

Une réservation non confirmée doit rendre son stock après un délai (15 minutes par défaut). Un job peut se perdre (Redis indisponible au moment de la planification), arriver en retard, arriver deux fois, ou arriver après une confirmation.

## Décision

- À la création, l'API planifie un job BullMQ différé, dont l'identifiant est dérivé de la réservation (planifier deux fois ne crée pas deux jobs), avec reprises à délai croissant.
- Le worker ne fait pas confiance au job : l'expiration ne passe que si la réservation est encore active **et** échue selon l'horloge de la base. Un job arrivé trop tôt, en double ou après une confirmation ne change rien.
- Si la planification échoue, la réservation reste valide (elle est déjà enregistrée) et un **balayage** répétitif (toutes les 30 s, un seul planificateur quel que soit le nombre de workers) expire les réservations échues sans job.
- Redis en `noeviction` : BullMQ ne doit jamais perdre une clé par manque de mémoire.

## Conséquences

- Le délai réel d'expiration est « échéance + au plus 30 s » dans le pire cas (job perdu).
- BullMQ est une file de travail, pas un bus d'événements : les événements métier passeront par l'outbox (incrément 3).
