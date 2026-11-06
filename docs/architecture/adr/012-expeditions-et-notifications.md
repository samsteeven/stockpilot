# ADR-012 : expéditions et messages aux clients, déclenchés par les événements

**État** : acceptée.

## Contexte

Une commande payée doit être préparée puis expédiée, et le client prévenu à chaque étape. Ces suites ne doivent pas ralentir ni faire échouer la confirmation du paiement (le prestataire attend une réponse rapide), et un serveur d'e-mails en panne ne doit ni bloquer l'entrepôt ni faire perdre un message.

## Décision

- **Expédition créée par le worker** à la réception de `order.confirmed` (outbox, [ADR-011](011-outbox-et-audit.md)), une seule par commande : contrainte d'unicité `(tenant_id, order_id)` et message marqué traité dans la même transaction. La notification du prestataire ne fait que confirmer la commande.
- **Cycle de vie** : à expédier → expédiée (transporteur et numéro de suivi obligatoires) → livrée. Un déclencheur refuse tout retour ou saut, une contrainte CHECK refuse une expédition sans suivi. Expédier de nouveau avec le même suivi est sans effet (requête rejouée) ; avec un autre, 409. Permission `shipments:write` : propriétaire, administrateur, responsable d'entrepôt.
- **Messages au client** pour `order.confirmed`, `order.cancelled`, `payment.refund_required`, `shipment.shipped`, `shipment.delivered`, quand la commande porte une adresse. Le message est d'abord **enregistré** (une ligne par événement et par modèle, contrainte d'unicité), puis **envoyé hors transaction** : un envoi lent ne garde aucun verrou. Échec : la ligne garde l'erreur et le nombre d'essais, l'exception fait rejouer le job (BullMQ, attente croissante) ; un message déjà envoyé n'est pas renvoyé quand l'événement est relivré.
- **Envoi SMTP** (nodemailer) derrière un port `MailSender` : Mailpit en local et dans la CI, un vrai relais (SES) au déploiement ; sans `SMTP_URL`, les messages sont seulement journalisés. Les messages envoyés sont consultables par `GET /notifications` (propriétaire et administrateur : ils contiennent les adresses des clients).

## Conséquences

- Un arrêt entre l'envoi et son marquage « envoyé » renverra le message : au pire un doublon, jamais une perte. Un identifiant de message idempotent chez le relais SMTP supprimerait ce cas ; pas nécessaire à ce stade.
- Les messages sont en texte, en français, sans modèle HTML ni désinscription : ce sont des messages transactionnels, pas du marketing.
- Testé : expédition créée une seule fois (événement relivré), pas d'expédition pour une commande non confirmée, transitions refusées par l'API et par la base, rejeu d'une expédition, permissions par rôle, isolation entre entreprises ; sur un vrai worker et un vrai serveur SMTP : message à la confirmation puis à l'expédition avec le numéro de suivi, serveur en panne puis rétabli (un seul message reçu, deux essais notés).
