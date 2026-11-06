import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { recordAudit } from '@stockpilot/audit';
import {
  type Order,
  type OrderItem,
  type OrderStatusHistory,
  type Payment,
  type Shipment,
  Prisma,
  TenantDatabase,
  type TenantTransaction,
} from '@stockpilot/database';
import {
  type ReservationWithItems,
  ReservationService,
} from '@stockpilot/inventory';
import { markProcessed, recordEvent } from '@stockpilot/messaging';
import {
  IdempotencyKeyReuseError,
  MixedCurrencyError,
  OrderNotCancellableError,
  OrderNotFoundError,
  UnknownVariantError,
  UnknownWarehouseError,
} from './errors.js';
import { leavePending, lockOrder } from './transitions.js';

export interface OrdersOptions {
  /** Durée de la réservation : le délai laissé au client pour payer. */
  reservationTtlSeconds: number;
  /**
   * Secret partagé avec le prestataire de paiement (signature de ses notifications). Absent dans le worker, qui
   * ne reçoit pas de notification.
   */
  paymentWebhookSecret?: string;
}

export const ORDERS_OPTIONS = Symbol('ORDERS_OPTIONS');

export interface OrderLine {
  variantId: string;
  quantity: number;
}

export interface PlaceOrderCommand {
  idempotencyKey: string;
  warehouseId: string;
  items: OrderLine[];
  customerEmail?: string;
}

export interface OrderView {
  id: string;
  status: string;
  warehouseId: string;
  currency: string;
  totalAmount: string;
  customerEmail: string | null;
  reservationId: string | null;
  cancelReason: string | null;
  createdAt: string;
  items: { variantId: string; quantity: number; unitPrice: string }[];
  payment: {
    providerReference: string;
    status: string;
    amount: string;
    currency: string;
  } | null;
  shipment?: {
    id: string;
    status: string;
    carrier: string | null;
    trackingNumber: string | null;
  } | null;
  /** Échéance de paiement (celle de la réservation), à la création seulement. */
  payBefore?: string;
}

export interface PlaceOrderResult {
  order: OrderView;
  /** Vrai quand la réponse est celle d'une requête précédente avec la même clé. */
  replayed: boolean;
}

export type OrderDetails = Order & {
  items: OrderItem[];
  history: OrderStatusHistory[];
  payments: Payment[];
  shipment?: Shipment | null;
};

/** Consommateur des événements « réservation expirée » (table processed_messages). */
export const ORDERS_CONSUMER = 'orders';

/**
 * Commandes : création (avec réservation du stock et paiement attendu), annulation, lecture.
 *
 * La commande, ses lignes, sa réservation, le paiement attendu, l'historique, l'audit, l'événement et la clé
 * d'idempotence sont écrits dans une seule transaction : tout ou rien.
 */
@Injectable()
export class OrderService {
  constructor(
    private readonly tenants: TenantDatabase,
    private readonly reservations: ReservationService,
    @Inject(ORDERS_OPTIONS) private readonly options: OrdersOptions,
  ) {}

  async place(
    tenantId: string,
    userId: string,
    command: PlaceOrderCommand,
  ): Promise<PlaceOrderResult> {
    const hash = requestHash(command);
    let reserved: ReservationWithItems | undefined;
    const result = await this.tenants.runAs(
      { tenantId, userId },
      async (tx): Promise<PlaceOrderResult> => {
        // Deux requêtes simultanées avec la même clé : la seconde attend la fin de la première, puis la rejoue.
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${command.idempotencyKey}`}, 0))`;
        const previous = await tx.idempotencyKey.findUnique({
          where: {
            tenantId_key: { tenantId, key: command.idempotencyKey },
          },
        });
        if (previous) {
          if (previous.requestHash !== hash)
            throw new IdempotencyKeyReuseError();
          return {
            order: previous.responseBody as unknown as OrderView,
            replayed: true,
          };
        }

        const { order, reservation } = await this.create(
          tx,
          tenantId,
          userId,
          command,
        );
        reserved = reservation;
        const view = toView(order, reservation.expiresAt);
        await tx.idempotencyKey.create({
          data: {
            tenantId,
            key: command.idempotencyKey,
            requestHash: hash,
            responseStatus: 201,
            responseBody: view as unknown as Prisma.InputJsonValue,
          },
        });
        return { order: view, replayed: false };
      },
    );
    if (reserved) await this.reservations.scheduleExpiry(tenantId, reserved);
    return result;
  }

  private async create(
    tx: TenantTransaction,
    tenantId: string,
    userId: string,
    command: PlaceOrderCommand,
  ): Promise<{ order: OrderDetails; reservation: ReservationWithItems }> {
    const lines = mergeLines(command.items);
    const warehouse = await tx.warehouse.findUnique({
      where: { id: command.warehouseId },
      select: { id: true },
    });
    if (!warehouse) throw new UnknownWarehouseError(command.warehouseId);

    // Le prix vient du catalogue, jamais du client ; la commande en garde une copie.
    const variants = await tx.productVariant.findMany({
      where: { id: { in: lines.map((l) => l.variantId) } },
      select: { id: true, unitPrice: true, currency: true },
    });
    const byId = new Map(variants.map((v) => [v.id, v]));
    const missing = lines.map((l) => l.variantId).filter((id) => !byId.has(id));
    if (missing.length > 0) throw new UnknownVariantError(missing);
    const currencies = [...new Set(variants.map((v) => v.currency))];
    if (currencies.length > 1) throw new MixedCurrencyError(currencies);
    const currency = currencies[0];

    const priced = lines.map((line) => ({
      ...line,
      unitPrice: byId.get(line.variantId)!.unitPrice,
    }));
    const total = priced.reduce(
      (sum, line) => sum.plus(line.unitPrice.times(line.quantity)),
      new Prisma.Decimal(0),
    );

    const created = await tx.order.create({
      data: {
        tenantId,
        warehouseId: command.warehouseId,
        currency,
        totalAmount: total,
        customerEmail: command.customerEmail?.toLowerCase() ?? null,
        createdBy: userId,
      },
    });
    await tx.orderItem.createMany({
      data: priced.map((line) => ({
        tenantId,
        orderId: created.id,
        variantId: line.variantId,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
      })),
    });

    // Stock insuffisant : l'exception annule toute la transaction, commande comprise.
    const { reservation } = await this.reservations.reserveIn(tx, tenantId, {
      reference: `order:${created.id}`,
      warehouseId: command.warehouseId,
      items: lines,
      ttlSeconds: this.options.reservationTtlSeconds,
    });
    await tx.order.update({
      where: { id: created.id },
      data: { reservationId: reservation.id },
    });
    await tx.payment.create({
      data: {
        tenantId,
        orderId: created.id,
        amount: total,
        currency,
        providerReference: `pay_${randomBytes(12).toString('hex')}`,
      },
    });
    await tx.orderStatusHistory.createMany({
      data: [
        {
          tenantId,
          orderId: created.id,
          fromStatus: null,
          toStatus: 'PENDING_PAYMENT',
          actorId: userId,
        },
      ],
    });
    await recordAudit(tx, {
      tenantId,
      actorId: userId,
      action: 'order.created',
      resourceType: 'order',
      resourceId: created.id,
      details: { totalAmount: total.toFixed(2), currency, lines: lines.length },
    });
    await recordEvent(tx, {
      tenantId,
      type: 'order.created',
      payload: {
        orderId: created.id,
        totalAmount: total.toFixed(2),
        currency,
      },
      correlationId: created.id,
    });
    return { order: await loadOrder(tx, created.id), reservation };
  }

  /** Annulation par un membre : la réservation est rendue. Annuler deux fois ne fait rien de plus. */
  async cancel(
    tenantId: string,
    userId: string,
    orderId: string,
  ): Promise<OrderView> {
    return this.tenants.runAs({ tenantId, userId }, async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (order.status === 'CANCELLED')
        return toView(await loadOrder(tx, orderId));
      if (order.status !== 'PENDING_PAYMENT')
        throw new OrderNotCancellableError(orderId, order.status);
      if (order.reservationId)
        await this.reservations.releaseIn(tx, tenantId, order.reservationId);
      await leavePending(tx, order, 'CANCELLED', userId, 'cancelled_by_user');
      await recordAudit(tx, {
        tenantId,
        actorId: userId,
        action: 'order.cancelled',
        resourceType: 'order',
        resourceId: orderId,
        details: { reason: 'cancelled_by_user' },
      });
      await recordEvent(tx, {
        tenantId,
        type: 'order.cancelled',
        payload: { orderId, reason: 'cancelled_by_user' },
        correlationId: orderId,
      });
      return toView(await loadOrder(tx, orderId));
    });
  }

  /**
   * Consommateur de « reservation.expired » : la commande encore en attente de paiement est annulée. Un événement
   * livré deux fois n'a d'effet qu'une fois ; une commande déjà payée ou annulée n'est pas touchée.
   */
  async onReservationExpired(
    eventId: string,
    tenantId: string,
    reservationId: string,
  ): Promise<'cancelled' | 'duplicate' | 'nothing-to-do'> {
    return this.tenants.run(tenantId, async (tx) => {
      if (!(await markProcessed(tx, ORDERS_CONSUMER, eventId)))
        return 'duplicate';
      const found = await tx.order.findFirst({
        where: { reservationId },
        select: { id: true },
      });
      if (!found) return 'nothing-to-do';
      const order = await lockOrder(tx, found.id);
      if (
        !(await leavePending(
          tx,
          order,
          'CANCELLED',
          null,
          'reservation_expired',
        ))
      )
        return 'nothing-to-do';
      await recordAudit(tx, {
        tenantId,
        actorId: null,
        action: 'order.cancelled',
        resourceType: 'order',
        resourceId: order.id,
        details: { reason: 'reservation_expired' },
      });
      await recordEvent(tx, {
        tenantId,
        type: 'order.cancelled',
        payload: { orderId: order.id, reason: 'reservation_expired' },
        correlationId: order.id,
      });
      return 'cancelled';
    });
  }

  async get(tenantId: string, orderId: string): Promise<OrderDetails> {
    return this.tenants.run(tenantId, (tx) => loadOrder(tx, orderId));
  }

  async list(
    tenantId: string,
    query: { status?: Order['status']; limit?: number; before?: Date } = {},
  ): Promise<OrderDetails[]> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    return this.tenants.run(tenantId, (tx) =>
      tx.order.findMany({
        where: {
          ...(query.status ? { status: query.status } : {}),
          ...(query.before ? { createdAt: { lt: query.before } } : {}),
        },
        include: ORDER_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
    );
  }
}

const ORDER_INCLUDE = {
  items: true,
  history: { orderBy: { createdAt: 'asc' } },
  payments: { orderBy: { createdAt: 'asc' } },
  shipment: true,
} as const;

export async function loadOrder(
  tx: TenantTransaction,
  orderId: string,
): Promise<OrderDetails> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: ORDER_INCLUDE,
  });
  if (!order) throw new OrderNotFoundError(orderId);
  return order;
}

export function toView(order: OrderDetails, payBefore?: Date): OrderView {
  const payment = order.payments.at(-1);
  return {
    id: order.id,
    status: order.status,
    warehouseId: order.warehouseId,
    currency: order.currency,
    totalAmount: order.totalAmount.toFixed(2),
    customerEmail: order.customerEmail,
    reservationId: order.reservationId,
    cancelReason: order.cancelReason,
    createdAt: order.createdAt.toISOString(),
    items: order.items.map((item) => ({
      variantId: item.variantId,
      quantity: item.quantity,
      unitPrice: item.unitPrice.toFixed(2),
    })),
    payment: payment
      ? {
          providerReference: payment.providerReference,
          status: payment.status,
          amount: payment.amount.toFixed(2),
          currency: payment.currency,
        }
      : null,
    ...(order.shipment !== undefined
      ? {
          shipment: order.shipment && {
            id: order.shipment.id,
            status: order.shipment.status,
            carrier: order.shipment.carrier,
            trackingNumber: order.shipment.trackingNumber,
          },
        }
      : {}),
    ...(payBefore ? { payBefore: payBefore.toISOString() } : {}),
  };
}

function mergeLines(items: OrderLine[]): OrderLine[] {
  const merged = new Map<string, number>();
  for (const item of items)
    merged.set(
      item.variantId,
      (merged.get(item.variantId) ?? 0) + item.quantity,
    );
  return [...merged].map(([variantId, quantity]) => ({ variantId, quantity }));
}

/** Empreinte de ce qui définit la commande ; la clé d'idempotence elle-même n'en fait pas partie. */
function requestHash(command: PlaceOrderCommand): string {
  const canonical = JSON.stringify({
    warehouseId: command.warehouseId,
    items: command.items.map((i) => [i.variantId, i.quantity]),
    customerEmail: command.customerEmail?.toLowerCase() ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
