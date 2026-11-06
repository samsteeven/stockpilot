import {
  type Order,
  OrderStatus,
  type TenantTransaction,
} from '@stockpilot/database';
import { OrderNotFoundError } from './errors.js';

/** Verrouille la commande pour la durée de la transaction : annulation, paiement et expiration passent l'un après l'autre. */
export async function lockOrder(
  tx: TenantTransaction,
  orderId: string,
): Promise<Order> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  const order = await tx.order.findUnique({ where: { id: orderId } });
  if (!order) throw new OrderNotFoundError(orderId);
  return order;
}

export type CancelReason =
  'cancelled_by_user' | 'payment_failed' | 'reservation_expired';

/**
 * Fait sortir une commande de « en attente de paiement », une seule fois : la mise à jour est conditionnelle, et un
 * déclencheur refuse de toute façon de modifier un statut final. Rend faux si la commande en était déjà sortie.
 */
export async function leavePending(
  tx: TenantTransaction,
  order: Pick<Order, 'id' | 'tenantId'>,
  to: 'CONFIRMED' | 'CANCELLED',
  actorId: string | null,
  reason?: CancelReason,
): Promise<boolean> {
  const { count } = await tx.order.updateMany({
    where: { id: order.id, status: OrderStatus.PENDING_PAYMENT },
    data: {
      status: to,
      cancelReason: to === 'CANCELLED' ? reason : null,
    },
  });
  if (count === 0) return false;
  await tx.orderStatusHistory.createMany({
    data: [
      {
        tenantId: order.tenantId,
        orderId: order.id,
        fromStatus: OrderStatus.PENDING_PAYMENT,
        toStatus: to,
        reason: reason ?? null,
        actorId,
      },
    ],
  });
  return true;
}
