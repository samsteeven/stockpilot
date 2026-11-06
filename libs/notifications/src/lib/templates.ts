import type { DomainEvent } from '@stockpilot/messaging';

/** Ce que le modèle d'e-mail sait de la commande au moment de l'envoi. */
export interface OrderFacts {
  orderId: string;
  tenantName: string;
  totalAmount: string;
  currency: string;
  cancelReason: string | null;
}

export interface RenderedMessage {
  template: string;
  subject: string;
  body: string;
}

const CANCEL_REASONS: Record<string, string> = {
  payment_failed: 'le paiement a été refusé',
  reservation_expired: 'le paiement n’est pas arrivé à temps',
  cancelled_by_user: 'elle a été annulée par le vendeur',
};

/** Événements qui donnent lieu à un message au client ; les autres n'en produisent aucun. */
export function render(
  event: DomainEvent,
  order: OrderFacts,
): RenderedMessage | undefined {
  const ref = order.orderId.slice(0, 8).toUpperCase();
  const amount = `${order.totalAmount} ${order.currency}`;
  const sign = `\n\n${order.tenantName}`;
  switch (event.type) {
    case 'order.confirmed':
      return {
        template: 'order-confirmed',
        subject: `Commande ${ref} confirmée`,
        body: `Bonjour,\n\nNous avons reçu votre paiement de ${amount}. Votre commande ${ref} est confirmée et sera préparée rapidement.${sign}`,
      };
    case 'order.cancelled':
      return {
        template: 'order-cancelled',
        subject: `Commande ${ref} annulée`,
        body: `Bonjour,\n\nVotre commande ${ref} est annulée : ${CANCEL_REASONS[order.cancelReason ?? ''] ?? 'elle a été annulée'}.${sign}`,
      };
    case 'payment.refund_required':
      return {
        template: 'refund-required',
        subject: `Commande ${ref} : remboursement en cours`,
        body: `Bonjour,\n\nVotre paiement de ${amount} est arrivé alors que la commande ${ref} ne pouvait plus être honorée. Il vous sera remboursé.${sign}`,
      };
    case 'shipment.shipped':
      return {
        template: 'shipment-shipped',
        subject: `Commande ${ref} expédiée`,
        body: `Bonjour,\n\nVotre commande ${ref} est en route avec ${String(event.payload['carrier'])}, numéro de suivi ${String(event.payload['trackingNumber'])}.${sign}`,
      };
    case 'shipment.delivered':
      return {
        template: 'shipment-delivered',
        subject: `Commande ${ref} livrée`,
        body: `Bonjour,\n\nVotre commande ${ref} a été livrée. Merci de votre confiance.${sign}`,
      };
    default:
      return undefined;
  }
}
