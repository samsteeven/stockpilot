import { Injectable, Module } from '@nestjs/common';
import { recordAudit } from '@stockpilot/audit';
import {
  type Shipment,
  ShipmentStatus,
  TenantDatabase,
  type TenantTransaction,
} from '@stockpilot/database';
import { markProcessed, recordEvent } from '@stockpilot/messaging';

export class ShipmentNotFoundError extends Error {
  constructor(readonly shipmentId: string) {
    super(`expédition ${shipmentId} introuvable`);
  }
}

/** Transition impossible : expédier deux fois avec un autre numéro, livrer avant d'expédier… */
export class ShipmentStateError extends Error {
  constructor(
    readonly shipmentId: string,
    readonly status: string,
    action: string,
  ) {
    super(`expédition ${shipmentId} : ${status}, impossible de ${action}`);
  }
}

export interface ShipCommand {
  carrier: string;
  trackingNumber: string;
}

/** Consommateur des événements « commande confirmée » (table processed_messages). */
export const SHIPPING_CONSUMER = 'shipping';

/**
 * Expéditions : une par commande confirmée, créée par le worker ; puis expédiée (transporteur et numéro de suivi)
 * et livrée par l'entrepôt. Le statut n'avance que dans un sens (déclencheur de la base).
 */
@Injectable()
export class ShipmentService {
  constructor(private readonly tenants: TenantDatabase) {}

  /** Une seule expédition par commande, même si l'événement est livré deux fois en même temps. */
  async onOrderConfirmed(
    eventId: string,
    tenantId: string,
    orderId: string,
  ): Promise<'created' | 'duplicate' | 'nothing-to-do'> {
    return this.tenants.run(tenantId, async (tx) => {
      if (!(await markProcessed(tx, SHIPPING_CONSUMER, eventId)))
        return 'duplicate';
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, warehouseId: true },
      });
      if (!order || order.status !== 'CONFIRMED') return 'nothing-to-do';
      const { count } = await tx.shipment.createMany({
        data: [{ tenantId, orderId, warehouseId: order.warehouseId }],
        skipDuplicates: true,
      });
      return count === 1 ? 'created' : 'nothing-to-do';
    });
  }

  list(
    tenantId: string,
    query: { status?: ShipmentStatus; limit?: number } = {},
  ): Promise<Shipment[]> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    return this.tenants.run(tenantId, (tx) =>
      tx.shipment.findMany({
        where: query.status ? { status: query.status } : {},
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
    );
  }

  get(tenantId: string, shipmentId: string): Promise<Shipment> {
    return this.tenants.run(tenantId, (tx) => load(tx, shipmentId));
  }

  /** Expédier une seconde fois avec le même numéro de suivi est sans effet (requête rejouée). */
  ship(
    tenantId: string,
    userId: string,
    shipmentId: string,
    command: ShipCommand,
  ): Promise<Shipment> {
    const carrier = command.carrier.trim();
    const trackingNumber = command.trackingNumber.trim();
    return this.tenants.runAs({ tenantId, userId }, async (tx) => {
      const { count } = await tx.shipment.updateMany({
        where: { id: shipmentId, status: ShipmentStatus.READY_TO_SHIP },
        data: {
          status: ShipmentStatus.SHIPPED,
          carrier,
          trackingNumber,
          shippedAt: new Date(),
        },
      });
      const shipment = await load(tx, shipmentId);
      if (count === 0) {
        if (
          shipment.status === ShipmentStatus.SHIPPED &&
          shipment.trackingNumber === trackingNumber &&
          shipment.carrier === carrier
        )
          return shipment;
        throw new ShipmentStateError(shipmentId, shipment.status, 'expédier');
      }
      await recordAudit(tx, {
        tenantId,
        actorId: userId,
        action: 'shipment.shipped',
        resourceType: 'shipment',
        resourceId: shipmentId,
        details: { orderId: shipment.orderId, carrier, trackingNumber },
      });
      await recordEvent(tx, {
        tenantId,
        type: 'shipment.shipped',
        payload: {
          shipmentId,
          orderId: shipment.orderId,
          carrier,
          trackingNumber,
        },
        correlationId: shipment.orderId,
      });
      return shipment;
    });
  }

  deliver(
    tenantId: string,
    userId: string,
    shipmentId: string,
  ): Promise<Shipment> {
    return this.tenants.runAs({ tenantId, userId }, async (tx) => {
      const { count } = await tx.shipment.updateMany({
        where: { id: shipmentId, status: ShipmentStatus.SHIPPED },
        data: { status: ShipmentStatus.DELIVERED, deliveredAt: new Date() },
      });
      const shipment = await load(tx, shipmentId);
      if (count === 0) {
        if (shipment.status === ShipmentStatus.DELIVERED) return shipment;
        throw new ShipmentStateError(shipmentId, shipment.status, 'livrer');
      }
      await recordAudit(tx, {
        tenantId,
        actorId: userId,
        action: 'shipment.delivered',
        resourceType: 'shipment',
        resourceId: shipmentId,
        details: { orderId: shipment.orderId },
      });
      await recordEvent(tx, {
        tenantId,
        type: 'shipment.delivered',
        payload: { shipmentId, orderId: shipment.orderId },
        correlationId: shipment.orderId,
      });
      return shipment;
    });
  }
}

async function load(
  tx: TenantTransaction,
  shipmentId: string,
): Promise<Shipment> {
  const shipment = await tx.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new ShipmentNotFoundError(shipmentId);
  return shipment;
}

@Module({ providers: [ShipmentService], exports: [ShipmentService] })
export class ShippingModule {}
