import type { DomainEvent } from '@stockpilot/messaging';
import { render } from './templates.js';

const order = {
  orderId: '3f2a9c10-0000-4000-8000-000000000000',
  tenantName: 'Atelier Nova',
  totalAmount: '99.80',
  currency: 'EUR',
  cancelReason: 'payment_failed',
};

function event(
  type: string,
  payload: Record<string, unknown> = {},
): DomainEvent {
  return {
    id: 'e',
    tenantId: 't',
    type,
    payload: { orderId: order.orderId, ...payload },
    correlationId: null,
    occurredAt: '',
  };
}

it('un message par événement qui concerne le client, avec la référence courte de la commande', () => {
  expect(render(event('order.confirmed'), order)).toMatchObject({
    template: 'order-confirmed',
    subject: 'Commande 3F2A9C10 confirmée',
  });
  expect(render(event('order.cancelled'), order)?.body).toContain(
    'le paiement a été refusé',
  );
  expect(
    render(
      event('shipment.shipped', {
        carrier: 'Colissimo',
        trackingNumber: '6A1',
      }),
      order,
    )?.body,
  ).toContain('Colissimo, numéro de suivi 6A1');
  expect(render(event('payment.refund_required'), order)?.body).toContain(
    '99.80 EUR',
  );
});

it('pas de message pour les événements internes', () => {
  expect(render(event('order.created'), order)).toBeUndefined();
  expect(render(event('reservation.expired'), order)).toBeUndefined();
});
