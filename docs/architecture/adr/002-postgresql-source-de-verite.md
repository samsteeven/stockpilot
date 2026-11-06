# ADR-002 : PostgreSQL source de vérité, invariants tenus par la base

**État** : acceptée.

## Contexte

Les invariants du stock (jamais négatif, jamais plus réservé que le physique, mouvements immuables, isolation entre entreprises) ne doivent pas dépendre de la seule correction du code : un bogue, une requête écrite à la main ou un futur module pourraient les contourner.

## Décision

- PostgreSQL est la seule source de vérité. Redis ne porte que des files de travail, jamais une quantité de stock.
- Les invariants critiques sont **aussi** des règles de la base, ajoutées à la migration générée par Prisma :
  - contraintes CHECK : stock physique et réservé positifs ou nuls, réservé jamais supérieur au physique, quantité de réservation positive, cohérence entre l'état d'une réservation et ses dates ;
  - déclencheur qui refuse toute modification ou suppression d'un mouvement de stock (on corrige par un mouvement compensatoire), et rôle applicatif sans droit UPDATE ni DELETE sur cette table ;
  - clés étrangères composites `(tenant_id, id)` et Row-Level Security ([ADR-004](004-isolation-multi-tenant-rls.md)).
- Identifiants UUID, dates `timestamptz`, montants en `Decimal` (à venir avec les commandes).

## Conséquences

- Le code reste responsable de répondre proprement (409, 422) ; la base garantit que même une erreur de code ne casse pas l'invariant. Les tests le vérifient en passant outre le code.
- Prisma ne connaît pas ces règles : elles vivent dans le SQL des migrations, et la CI vérifie que la base migrée correspond toujours au schéma Prisma.
