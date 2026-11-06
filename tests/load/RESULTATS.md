# Tests de charge : résultats de référence

Mesures du 2026-11-06 sur le poste de développement (Windows 11, 16 cœurs, 8 Go pour Docker) : une instance de l'API et une du worker construites (`node dist/main.js`), PostgreSQL 18 et Redis 8 dans Docker, k6 2.2 sur la même machine. Ce sont des **ordres de grandeur pour comparer**, pas des engagements : la même mesure sur l'infrastructure AWS est prévue à l'incrément 6.

## Contention : 200 acheteurs pour 50 unités

`k6 run tests/load/contention.js`

| Mesure                        | Résultat                              |
| ----------------------------- | ------------------------------------- |
| Réservations acceptées        | **50** (exactement)                   |
| Réservations refusées (409)   | **150**                               |
| Stock après coup              | physique 50, réservé 50, disponible 0 |
| Erreurs                       | 0                                     |
| Latence p95 d'une réservation | 1,1 à 1,2 s                           |

Les 200 requêtes visent la même ligne de stock : PostgreSQL les fait passer l'une après l'autre (verrou de ligne). C'est le prix de la garantie « jamais de survente », payé seulement quand tout le monde veut le même article au même instant.

## Parcours : vendeurs, commandes, paiements, annulations

`PAYMENT_WEBHOOK_SECRET=… k6 run tests/load/parcours.js` : chaque vendeur lit le stock, crée une commande (une sur dix envoyée deux fois avec la même `Idempotency-Key`), puis le client paie (8 fois sur 10, notification signée) ou la commande est annulée, enfin la commande est relue.

| Charge                           | Débit     | p95 lecture du stock | p95 création de commande | p95 notification de paiement | Erreurs |
| -------------------------------- | --------- | -------------------- | ------------------------ | ---------------------------- | ------- |
| 20 vendeurs, 20 articles         | 50 req/s  | 15 ms                | 67 ms                    | 49 ms                        | 0       |
| 100 vendeurs, 1 article          | 104 req/s | 632 ms               | 924 ms                   | 915 ms                       | 0       |
| 100 vendeurs, 1 article, pool 30 | 103 req/s | 446 ms               | 1,59 s                   | 1,62 s                       | 0       |
| 100 vendeurs, 20 articles        | 126 req/s | 363 ms               | 759 ms                   | 613 ms                       | 0       |

Après chaque exécution, le worker a tout rattrapé : outbox vide, aucun job en échec, expéditions et e-mails créés.

## Ce que montrent les mesures

1. **Jusqu'à 20 vendeurs simultanés, tout passe largement** sous les objectifs (lecture < 200 ms, écriture < 400 ms au p95).
2. **La limite d'une instance de l'API est d'environ 100 à 125 requêtes par seconde** sur ce poste. Pendant la charge, le processus de l'API occupe un cœur entier (Node.js exécute le JavaScript sur un seul fil), alors que PostgreSQL n'en occupe que 1,2 sur 16. Hypothèse vérifiée : **le goulot est le processus de l'API, pas la base**.
3. **Agrandir le pool de connexions n'aide pas** (10 → 30) : même débit, et les écritures attendent plus longtemps leurs verrous. Hypothèse écartée.
4. **Une ligne de stock très demandée coûte** environ 20 % de débit (104 contre 126 req/s) : toutes les commandes du même article dans le même entrepôt se suivent sur son verrou.

## Suites

- Plusieurs instances de l'API derrière le répartiteur de charge (incrément 6), puis remesurer : le débit doit croître avec le nombre d'instances tant que PostgreSQL suit.
- Raccourcir la durée du verrou sur la ligne de stock : réserver en dernier dans la transaction de commande (aujourd'hui, la commande, le paiement attendu, l'audit et l'outbox sont écrits pendant que la ligne est verrouillée). À mesurer avant de changer.
- Profil CPU de l'API sous charge (`node --cpu-prof`) pour savoir ce qui coûte le plus : requêtes Prisma, validation, journaux.
