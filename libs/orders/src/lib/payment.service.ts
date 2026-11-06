import { Inject, Injectable, Logger } from '@nestjs/common';
import { recordAudit } from '@stockpilot/audit';
import {
  type Order,
  type Payment,
  PrismaService,
  TenantDatabase,
  type TenantTransaction,
} from '@stockpilot/database';
import {
  ReservationExpiredError,
  ReservationNotActiveError,
  ReservationService,
} from '@stockpilot/inventory';
import { markProcessed, recordEvent } from '@stockpilot/messaging';
import {
  InvalidPaymentEventError,
  PaymentMismatchError,
  PaymentNotFoundError,
} from './errors.js';
import { ORDERS_OPTIONS, type OrdersOptions } from './order.service.js';
import { verifySignature } from './signature.js';
import { leavePending, lockOrder } from './transitions.js';

/** Notification du prestataire de paiement (corps JSON signé). */
export interface PaymentNotification {
  /** Identifiant unique de la notification chez le prestataire : une notification renvoyée a le même. */
  id: string;
  type: 'payment.succeeded' | 'payment.failed';
  data: { providerReference: string; amount: string; currency: string };
}

export type PaymentOutcome =
  | 'confirmed'
  | 'cancelled'
  | 'refund-required'
  | 'duplicate'
  | 'already-settled';

/** Consommateur des notifications du prestataire (table processed_messages). */
export const PAYMENT_PROVIDER_CONSUMER = 'payment-provider';

/**
 * Retour du prestataire de paiement.
 *
 * Paiement accepté : la réservation devient une sortie de stock et la commande est confirmée. Si la réservation a
 * expiré entre-temps, rien n'est sorti du stock : la commande est annulée et le paiement marqué « à rembourser »
 * (compensation). Paiement refusé : la réservation est rendue et la commande annulée.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantDatabase,
    private readonly reservations: ReservationService,
    @Inject(ORDERS_OPTIONS) private readonly options: OrdersOptions,
  ) {}

  async handleNotification(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<{ outcome: PaymentOutcome; orderId: string }> {
    const secret = this.options.paymentWebhookSecret;
    if (!secret)
      throw new Error('secret du prestataire de paiement non configuré');
    verifySignature(secret, rawBody, signature);
    const notification = parseNotification(rawBody!);

    // Le prestataire ne connaît pas l'entreprise : une fonction réservée la retrouve depuis sa référence.
    const [found] = await this.prisma.$queryRaw<
      { id: string; tenant_id: string; order_id: string }[]
    >`SELECT * FROM payment_by_provider_reference(${notification.data.providerReference})`;
    if (!found)
      throw new PaymentNotFoundError(notification.data.providerReference);

    const outcome = await this.tenants.run(found.tenant_id, async (tx) => {
      if (
        !(await markProcessed(tx, PAYMENT_PROVIDER_CONSUMER, notification.id))
      )
        return 'duplicate' as const;
      // Même ordre de verrouillage que l'annulation et l'expiration : la commande d'abord.
      const order = await lockOrder(tx, found.order_id);
      await tx.$queryRaw`SELECT id FROM payments WHERE id = ${found.id}::uuid FOR UPDATE`;
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: found.id },
      });
      if (payment.status !== 'PENDING') return 'already-settled' as const;

      if (notification.type === 'payment.failed') {
        return this.onFailed(tx, order, payment, notification);
      }
      if (
        notification.data.amount !== payment.amount.toFixed(2) ||
        notification.data.currency !== payment.currency
      ) {
        // Annulé (rien n'est marqué traité) : la notification pourra être rejouée une fois l'écart expliqué.
        throw new PaymentMismatchError(
          `attendu ${payment.amount.toFixed(2)} ${payment.currency}, reçu ${notification.data.amount} ${notification.data.currency}`,
        );
      }
      return this.onSucceeded(tx, order, payment, notification);
    });
    this.logger.log(
      `Paiement ${notification.data.providerReference} (${notification.type}) : ${outcome}`,
    );
    return { outcome, orderId: found.order_id };
  }

  private async onFailed(
    tx: TenantTransaction,
    order: Order,
    payment: Payment,
    notification: PaymentNotification,
  ): Promise<PaymentOutcome> {
    await settle(tx, payment, 'FAILED');
    let outcome: PaymentOutcome = 'already-settled';
    if (order.status === 'PENDING_PAYMENT') {
      if (order.reservationId)
        await this.reservations.releaseIn(
          tx,
          order.tenantId,
          order.reservationId,
        );
      await leavePending(tx, order, 'CANCELLED', null, 'payment_failed');
      await recordEvent(tx, {
        tenantId: order.tenantId,
        type: 'order.cancelled',
        payload: { orderId: order.id, reason: 'payment_failed' },
        correlationId: order.id,
      });
      outcome = 'cancelled';
    }
    await recordAudit(tx, {
      tenantId: order.tenantId,
      actorId: null,
      action: 'payment.failed',
      resourceType: 'order',
      resourceId: order.id,
      details: {
        providerReference: payment.providerReference,
        notificationId: notification.id,
      },
    });
    return outcome;
  }

  private async onSucceeded(
    tx: TenantTransaction,
    order: Order,
    payment: Payment,
    notification: PaymentNotification,
  ): Promise<PaymentOutcome> {
    if (order.status === 'PENDING_PAYMENT' && order.reservationId) {
      try {
        await this.reservations.confirmIn(
          tx,
          order.tenantId,
          order.reservationId,
        );
      } catch (error) {
        // La réservation a expiré (ou a été rendue) avant le paiement : le stock n'est plus garanti.
        if (
          !(error instanceof ReservationExpiredError) &&
          !(error instanceof ReservationNotActiveError)
        )
          throw error;
        await leavePending(tx, order, 'CANCELLED', null, 'reservation_expired');
        return this.requireRefund(tx, order, payment, notification);
      }
      await settle(tx, payment, 'SUCCEEDED');
      await leavePending(tx, order, 'CONFIRMED', null);
      await recordAudit(tx, {
        tenantId: order.tenantId,
        actorId: null,
        action: 'payment.succeeded',
        resourceType: 'order',
        resourceId: order.id,
        details: {
          providerReference: payment.providerReference,
          notificationId: notification.id,
        },
      });
      await recordEvent(tx, {
        tenantId: order.tenantId,
        type: 'order.confirmed',
        payload: { orderId: order.id },
        correlationId: order.id,
      });
      return 'confirmed';
    }
    // Commande déjà annulée (par un membre, ou réservation expirée) : l'argent reçu doit être rendu.
    return this.requireRefund(tx, order, payment, notification);
  }

  private async requireRefund(
    tx: TenantTransaction,
    order: Order,
    payment: Payment,
    notification: PaymentNotification,
  ): Promise<PaymentOutcome> {
    await settle(tx, payment, 'REFUND_REQUIRED');
    await recordAudit(tx, {
      tenantId: order.tenantId,
      actorId: null,
      action: 'payment.refund_required',
      resourceType: 'order',
      resourceId: order.id,
      details: {
        providerReference: payment.providerReference,
        notificationId: notification.id,
      },
    });
    await recordEvent(tx, {
      tenantId: order.tenantId,
      type: 'payment.refund_required',
      payload: {
        orderId: order.id,
        providerReference: payment.providerReference,
        amount: payment.amount.toFixed(2),
        currency: payment.currency,
      },
      correlationId: order.id,
    });
    return 'refund-required';
  }
}

async function settle(
  tx: TenantTransaction,
  payment: Payment,
  status: 'SUCCEEDED' | 'FAILED' | 'REFUND_REQUIRED',
): Promise<void> {
  await tx.payment.update({
    where: { id: payment.id },
    data: { status, settledAt: new Date() },
  });
}

function parseNotification(rawBody: Buffer): PaymentNotification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new InvalidPaymentEventError('corps JSON invalide');
  }
  const n = parsed as Partial<PaymentNotification>;
  const valid =
    typeof n?.id === 'string' &&
    n.id.length > 0 &&
    n.id.length <= 200 &&
    (n.type === 'payment.succeeded' || n.type === 'payment.failed') &&
    typeof n.data?.providerReference === 'string' &&
    typeof n.data.amount === 'string' &&
    /^\d+\.\d{2}$/.test(n.data.amount) &&
    typeof n.data.currency === 'string';
  if (!valid) throw new InvalidPaymentEventError('notification incomplète');
  return n as PaymentNotification;
}
