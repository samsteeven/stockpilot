# ADR-005 : réservation atomique, ordre de verrouillage fixe, un seul état final

**État** : acceptée.

## Contexte

Deux clients commandent en même temps les dernières unités : une seule commande doit passer. Une commande multi-articles doit réserver tout ou rien. Une réservation ne doit être confirmée, libérée ou expirée qu'une fois, même si ces événements arrivent ensemble.

## Options

1. Lire le disponible, vérifier en code, puis écrire : deux transactions lisent 5, toutes deux réservent 4. Survente.
2. `SELECT … FOR UPDATE` puis écriture : correct, mais deux allers-retours et un verrou tenu plus longtemps.
3. Verrouillage optimiste par version, avec reprise : correct, mais beaucoup de reprises sur un article très demandé.
4. **Mise à jour conditionnelle** : on n'augmente le réservé que si le disponible suffit, dans la même instruction, et on lit le résultat avec `RETURNING`. Zéro ligne : stock insuffisant.

## Décision

Option 4, dans une transaction qui crée aussi la réservation et ses lignes :

- les lignes de stock sont mises à jour **dans l'ordre de leur identifiant** : deux commandes A+B et B+A ne s'interbloquent pas ;
- une ligne en défaut annule toute la transaction ; la réponse liste chaque manque (demandé, disponible) ;
- la **référence** de l'appelant est unique par entreprise : rejouer la même requête rend la même réservation (200) ; deux envois simultanés de la même référence n'en créent qu'une (le second perd sur la contrainte d'unicité, sa transaction est annulée) ;
- confirmation, libération et expiration passent par une mise à jour conditionnelle de la réservation (encore active, et pas échue pour confirmer, échue pour expirer). PostgreSQL sérialise ces mises à jour sur la ligne : un seul gagnant, les autres constatent l'état final.

## Conséquences

- Confirmer deux fois ne sort le stock qu'une fois ; libérer une réservation confirmée est refusé (409).
- Prouvé par des courses rejouées : 20 commandes simultanées pour 5 unités (10 tours), 2 × 4 pour 5, A+B contre B+A, même référence 10 fois, confirmation contre libération (20 tours), expiration en double.
