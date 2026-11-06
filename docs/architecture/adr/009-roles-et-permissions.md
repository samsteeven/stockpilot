# ADR-009 : entreprises, membres et permissions

**État** : acceptée.

## Contexte

Une personne peut appartenir à plusieurs entreprises, avec un rôle différent dans chacune. Un membre retiré ou rétrogradé ne doit pas garder ses droits jusqu'à l'expiration de son jeton. Chaque route doit dire ce qu'elle exige, et un oubli doit fermer l'accès plutôt que l'ouvrir.

## Décision

- **Rôles** : propriétaire, administrateur, responsable d'entrepôt, opérateur, lecteur. Ils accordent des **permissions** (`stock:read`, `stock:receive`, `reservations:write`, `catalog:write`, `warehouses:write`, `members:read`, `members:manage`, et depuis l'incrément 3 `orders:read` pour tous, `orders:write` pour tous sauf le lecteur, `audit:read` pour le propriétaire et l'administrateur) ; une route déclare la permission qu'elle exige.
- **Un seul garde global**, dans cet ordre : jeton valide (sauf route publique) ; pour une route d'entreprise, `X-Tenant-Id` désigne l'entreprise choisie, et l'adhésion est **relue en base à chaque requête** ; la permission est accordée par le rôle. Pas membre : 404, comme une entreprise inexistante. Rôle insuffisant : 403. Une route d'entreprise sans permission déclarée est refusée.
- **Règles de rôle** (dans le service, en plus de la permission) : un administrateur gère les membres, mais ne nomme pas de propriétaire et ne modifie ni ne retire un propriétaire. Tout membre peut se retirer lui-même.
- **Dernier propriétaire** : un déclencheur de contrainte, vérifié au COMMIT, refuse toute modification ou suppression qui laisserait une entreprise sans propriétaire, quelle que soit la requête.
- **Invitations** : jeton aléatoire montré une seule fois à l'administrateur (pas encore d'envoi d'e-mail), seule son empreinte est stockée ; valable 7 jours, à usage unique, pour l'adresse invitée seulement. La personne invitée n'appartient pas encore à l'entreprise : une fonction `SECURITY DEFINER` retrouve l'invitation par l'empreinte de son jeton, et rien d'autre.
- **Adhésions et Row-Level Security** : une personne lit ses propres adhésions (liste de ses entreprises) depuis son seul contexte utilisateur, mais ne peut les modifier que dans le contexte de l'entreprise : elle ne peut pas se donner un rôle elle-même, même par une requête directe.

## Conséquences

- Une lecture d'adhésion par requête : coût faible, mesuré à l'incrément 5 ; un cache de quelques secondes serait possible, au prix d'un délai de révocation.
- La condition « invitation non encore acceptée » de la mise à jour est redondante avec la vérification qui la précède et avec la clé primaire de l'adhésion : sa suppression ne fait échouer aucun test. Elle est gardée comme défense en profondeur, et ce constat est noté ici plutôt que caché.
- Testé : la matrice entière (5 rôles × 8 actions), un membre retiré qui perd l'accès à la requête suivante, un rôle abaissé, les règles de l'administrateur, le dernier propriétaire (par l'API et par une requête directe), invitations (adresse, usage unique, acceptation simultanée, ancien lien après retrait), isolation entre entreprises.
