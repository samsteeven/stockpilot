# ADR-001 : monolithe modulaire Nx, API et worker séparés

**État** : acceptée.

## Contexte

Le périmètre (stocks, réservations, commandes, expéditions, notifications) a des frontières claires, mais pas de besoin de déploiement indépendant ni d'équipes séparées. Les traitements asynchrones (expiration des réservations, notifications) ne doivent pas ralentir les requêtes HTTP.

## Options

1. **Microservices** : frontières imposées par le réseau, mais transactions distribuées, déploiement et observabilité bien plus lourds pour un seul développeur et trois mois.
2. **Application NestJS unique** : simple, mais les traitements de fond partagent le processus de l'API.
3. **Monolithe modulaire** dans un monorepo Nx : des bibliothèques par domaine (`libs/inventory`, `libs/database`…), deux applications (`apps/api`, `apps/worker`) qui les assemblent.

## Décision

Option 3. Les modules exposent des services et des contrats (`ReservationService`, le port `ReservationExpiryScheduler`), jamais leurs tables à un autre domaine. L'API et le worker sont deux processus et deux conteneurs, qui se mettent à l'échelle séparément.

## Conséquences

- Une seule base, donc des transactions locales là où des microservices auraient demandé des sagas.
- Les frontières reposent sur la discipline et sur Nx (dépendances déclarées entre projets, références TypeScript) ; une règle de lint sur les frontières de modules viendra quand les domaines se multiplieront.
- À revoir si un domaine doit être déployé ou dimensionné indépendamment (Analytics, par exemple), ou si plusieurs équipes y travaillent.
