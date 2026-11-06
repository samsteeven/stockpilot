# ADR-007 : tests contre de vraies bases, courses rejouées, garde-fous cassés volontairement

**État** : acceptée.

## Contexte

Les garanties de StockPilot (pas de survente, isolation, un seul état final) tiennent dans la base et dans la concurrence. Des doubles de test les feraient passer sans rien prouver.

## Décision

- Tests d'intégration contre **PostgreSQL 18 et Redis réels** : conteneurs jetables (Testcontainers, données en mémoire) ou services déjà démarrés (`STOCKPILOT_TEST_DATABASE_URL`, `STOCKPILOT_TEST_APP_DATABASE_URL`, `STOCKPILOT_TEST_REDIS_URL`). Migrations appliquées comme en production, rôle applicatif soumis à la RLS.
- Chaque test crée sa propre entreprise : aucune donnée partagée, même sur une base commune.
- Les courses sont **rejouées** (10 à 20 tours) : une exécution chanceuse ne prouve rien.
- Chaque garde-fou est **cassé volontairement** une fois, pour vérifier qu'un test échoue : condition de disponibilité, ordre de verrouillage, condition d'état de la confirmation et de l'expiration, contrôle de l'échéance, rattrapage de la référence en double, contexte d'entreprise absent ou posé pour la session. Les huit casses sont détectées.

## Conséquences

- Les tests demandent Docker ; ils restent rapides (une base pour toute la suite).
- Le test de l'ordre de verrouillage repose sur la probabilité d'un interblocage entre 30 réservations croisées : il a détecté la casse, mais un tel test peut, en théorie, passer par chance.
