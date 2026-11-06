# ADR-010 : commandes, Idempotency-Key, paiement signé et compensation

**État** : acceptée.

## Contexte

Une commande engage trois choses : du stock (réservé, puis sorti), de l'argent (chez un prestataire de paiement) et un client qui peut renvoyer sa requête (réseau coupé, double clic, nouvel essai automatique). Le prestataire, lui, notifie le résultat quand il veut, parfois deux fois, parfois après l'échéance de la réservation. Aucune de ces situations ne doit produire deux commandes, une sortie de stock sans paiement, ni un paiement encaissé pour une commande qu'on ne peut plus servir sans que personne ne le sache.

## Options étudiées

- **Idempotence** : référence de commande choisie par le client (comme les réservations de l'incrément 1) ; en-tête `Idempotency-Key` avec réponse mémorisée ; aucune. La référence suffit à ne pas réserver deux fois, mais pas à rendre au client la même réponse, ni à refuser une même clé réutilisée pour une autre commande.
- **Paiement** : appel synchrone au prestataire pendant la création ; paiement attendu, confirmé par une notification. Le second est la forme réelle des prestataires (paiement 3-D Secure, virement) et ne garde pas une transaction ouverte pendant un appel externe.
- **Paiement après l'échéance** : confirmer quand même (le stock est peut-être parti ailleurs) ; refuser la notification (l'argent est pourtant encaissé) ; annuler et exiger un remboursement.

## Décision

- **Idempotency-Key obligatoire** sur `POST /orders`. La clé est enregistrée avec l'empreinte de la requête et la réponse, **dans la transaction de la commande** : commande, lignes, réservation, paiement attendu, historique, audit, événement et clé sont validés ou annulés ensemble. Même clé et même requête : la réponse d'origine est rejouée (201, en-tête `Idempotent-Replayed`) ; même clé, autre requête : 422. Deux requêtes simultanées avec la même clé sont sérialisées par un verrou consultatif de transaction (`pg_advisory_xact_lock`) : la seconde attend la première, puis la rejoue. Une requête refusée (stock insuffisant) n'enregistre pas sa clé : elle peut être retentée.
- **Le prix vient du catalogue**, jamais du client (un champ `unitPrice` dans la requête est refusé). Montants en `numeric(14,2)`, calculés en décimal, exposés en chaîne (`"99.80"`). Une commande est dans une seule devise. Le prix est copié dans la ligne de commande : un changement de catalogue ne modifie pas une commande passée.
- **Paiement par notification signée.** Le prestataire appelle `POST /payments/webhook` avec l'en-tête `Stockpilot-Signature: t=<horodatage>,v1=<HMAC-SHA256>`, calculé sur `horodatage.corps_brut` avec un secret partagé (`PAYMENT_WEBHOOK_SECRET`). Signature comparée en temps constant, horodatage à 5 minutes près (au-delà, un rejeu est refusé). Le corps brut est conservé par Nest (`rawBody`) : la signature porte sur les octets reçus. La notification ne connaît que la référence du paiement : une fonction `SECURITY DEFINER` retrouve l'entreprise et la commande, et rien d'autre. Chaque notification est traitée une fois (son identifiant entre dans `processed_messages`, dans la même transaction), et le montant et la devise doivent être ceux attendus.
- **Compensation** :
  - paiement refusé : réservation rendue, commande annulée (`payment_failed`) ;
  - paiement accepté, réservation encore valide : la réservation devient une sortie de stock, la commande est confirmée ;
  - paiement accepté après l'échéance (ou après une annulation) : **rien ne sort du stock**, la commande est annulée et le paiement passe à `REFUND_REQUIRED`, avec un événement `payment.refund_required` ;
  - pas de paiement à temps : le worker expire la réservation et annule la commande (`reservation_expired`) par l'outbox ([ADR-011](011-outbox-et-audit.md)).
- **Un seul état final** : la sortie de « en attente de paiement » est une mise à jour conditionnelle, la commande est verrouillée (`FOR UPDATE`) par l'annulation, le paiement et l'expiration, dans cet ordre (commande puis paiement), et des déclencheurs refusent de modifier une commande confirmée ou annulée, ou un paiement réglé, quelle que soit la requête.

## Conséquences

- Le paiement est **simulé** : le prestataire est remplacé par les tests et par `scripts/demo-commande.mjs`, qui signent leurs notifications comme le ferait un vrai prestataire. Brancher un vrai prestataire demande d'adapter le format de la notification, pas le traitement.
- Le remboursement n'est pas exécuté : il est exigé (statut, audit, événement). Un consommateur le déclenchera quand un vrai prestataire sera branché.
- Les clés d'idempotence ne sont pas purgées ; une rétention (24 h chez la plupart des prestataires) sera ajoutée avec le nettoyage périodique.
- Testé : clé absente, rejeu, même clé avec une autre commande, 10 requêtes simultanées avec la même clé (une commande, une réservation), prix imposé par le client, stock insuffisant (rien n'est créé), signature fausse, d'un autre secret, trop ancienne ou portant sur un corps modifié, montant inattendu, notification renvoyée, paiement refusé, paiement après expiration, paiement après annulation, annulation d'une commande confirmée, statuts finaux modifiés par une requête SQL directe. Le retrait de chacune de ces protections fait échouer un test.
