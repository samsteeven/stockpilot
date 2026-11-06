import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  isUniqueViolation,
  PrismaService,
  Reservation,
  ReservationItem,
  StockMovementType,
  TenantDatabase,
  TenantTransaction,
} from '@stockpilot/database';
import {
  InsufficientStockError,
  ReservationExpiredError,
  ReservationNotActiveError,
  ReservationNotFoundError,
  Shortage,
  UnknownStockItemError,
} from './errors.js';
import {
  RESERVATION_EXPIRY_SCHEDULER,
  type ReservationExpiryScheduler,
} from './expiry-scheduler.js';

export interface ReserveLine {
  variantId: string;
  quantity: number;
}

export interface ReserveCommand {
  /** Référence de l'appelant (la commande) : la même référence ne réserve qu'une fois. */
  reference: string;
  warehouseId: string;
  items: ReserveLine[];
  ttlSeconds: number;
}

export type ReservationWithItems = Reservation & { items: ReservationItem[] };

export interface Outcome {
  reservation: ReservationWithItems;
  /** Faux quand l'appel n'a rien changé : réservation déjà existante, déjà confirmée, déjà terminée. */
  changed: boolean;
}

type EndStatus = 'RELEASED' | 'EXPIRED';

/**
 * Réserver, confirmer, libérer, expirer.
 *
 * Garanties, tenues par la base et non par le code seul :
 * - jamais plus réservé que le physique : la mise à jour ne passe que si le disponible suffit (et une contrainte
 *   CHECK le refuse de toute façon) ;
 * - tout ou rien : une ligne en défaut annule la transaction entière ;
 * - pas d'interblocage entre deux réservations multi-articles : les lignes sont verrouillées dans un ordre fixe ;
 * - un seul état final : confirmation, libération et expiration passent toutes par une mise à jour conditionnelle
 *   de la réservation (status = 'ACTIVE'), que PostgreSQL sérialise sur la ligne.
 */
@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);

  constructor(
    private readonly tenants: TenantDatabase,
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(RESERVATION_EXPIRY_SCHEDULER)
    private readonly scheduler?: ReservationExpiryScheduler,
  ) {}

  async reserve(tenantId: string, command: ReserveCommand): Promise<Outcome> {
    const lines = mergeLines(command.items);
    let outcome: Outcome;
    try {
      outcome = await this.tenants.run(tenantId, async (tx) => {
        const existing = await findByReference(tx, tenantId, command.reference);
        if (existing) return { reservation: existing, changed: false };

        const stock = await tx.stockItem.findMany({
          where: {
            warehouseId: command.warehouseId,
            variantId: { in: lines.map((l) => l.variantId) },
          },
          select: { id: true, variantId: true },
        });
        const stockByVariant = new Map(stock.map((s) => [s.variantId, s.id]));
        const planned = lines.map((line) => {
          const stockItemId = stockByVariant.get(line.variantId);
          if (!stockItemId) throw new UnknownStockItemError(line.variantId);
          return { ...line, stockItemId };
        });
        // Ordre fixe de verrouillage : deux commandes A+B et B+A ne s'attendent pas mutuellement.
        planned.sort((a, b) => a.stockItemId.localeCompare(b.stockItemId));

        const shortages: Shortage[] = [];
        for (const line of planned) {
          const updated = await tx.$queryRaw<{ id: string }[]>`
            UPDATE stock_items
            SET quantity_reserved = quantity_reserved + ${line.quantity}, version = version + 1, updated_at = now()
            WHERE id = ${line.stockItemId}::uuid
              AND quantity_on_hand - quantity_reserved >= ${line.quantity}
            RETURNING id`;
          if (updated.length === 0) {
            const [row] = await tx.$queryRaw<{ available: number }[]>`
              SELECT quantity_on_hand - quantity_reserved AS available FROM stock_items WHERE id = ${line.stockItemId}::uuid`;
            shortages.push({
              variantId: line.variantId,
              requested: line.quantity,
              available: row?.available ?? 0,
            });
          }
        }
        if (shortages.length > 0) throw new InsufficientStockError(shortages);

        const created = await tx.reservation.create({
          data: {
            tenantId,
            reference: command.reference,
            expiresAt: new Date(Date.now() + command.ttlSeconds * 1000),
          },
        });
        await tx.reservationItem.createMany({
          data: planned.map((line) => ({
            tenantId,
            reservationId: created.id,
            stockItemId: line.stockItemId,
            quantity: line.quantity,
          })),
        });
        return { reservation: await load(tx, created.id), changed: true };
      });
    } catch (error) {
      // Deux appels simultanés avec la même référence : le second perd sur la contrainte d'unicité et rend la
      // réservation du premier, sans avoir rien gardé (sa transaction est annulée, son stock rendu).
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.tenants.run(tenantId, (tx) =>
        findByReference(tx, tenantId, command.reference),
      );
      if (!existing) throw error;
      return { reservation: existing, changed: false };
    }

    if (outcome.changed)
      await this.scheduleExpiry(tenantId, outcome.reservation);
    return outcome;
  }

  /** La réservation devient une sortie de stock. Confirmer deux fois ne sort le stock qu'une fois. */
  async confirm(tenantId: string, reservationId: string): Promise<Outcome> {
    return this.tenants.run(tenantId, async (tx) => {
      const won = await tx.$queryRaw<{ id: string }[]>`
        UPDATE reservations SET status = 'CONFIRMED'::"ReservationStatus", confirmed_at = now()
        WHERE id = ${reservationId}::uuid AND status = 'ACTIVE'::"ReservationStatus" AND expires_at > now()
        RETURNING id`;
      if (won.length === 0) {
        const current = await load(tx, reservationId);
        if (current.status === 'CONFIRMED')
          return { reservation: current, changed: false };
        if (current.status === 'ACTIVE')
          throw new ReservationExpiredError(reservationId);
        throw new ReservationNotActiveError(reservationId, current.status);
      }
      const reservation = await load(tx, reservationId);
      for (const item of sortedItems(reservation)) {
        await tx.$executeRaw`
          UPDATE stock_items
          SET quantity_on_hand = quantity_on_hand - ${item.quantity},
              quantity_reserved = quantity_reserved - ${item.quantity},
              version = version + 1, updated_at = now()
          WHERE id = ${item.stockItemId}::uuid`;
      }
      await tx.stockMovement.createMany({
        data: reservation.items.map((item) => ({
          tenantId,
          stockItemId: item.stockItemId,
          type: StockMovementType.SALE,
          quantity: -item.quantity,
          referenceId: reservation.id,
        })),
      });
      return { reservation, changed: true };
    });
  }

  /** Annulation par l'appelant (paiement refusé, commande annulée). */
  release(tenantId: string, reservationId: string): Promise<Outcome> {
    return this.end(tenantId, reservationId, 'RELEASED');
  }

  /** Expiration : seulement si le délai est réellement dépassé en base, quel que soit le moment où le job arrive. */
  expire(tenantId: string, reservationId: string): Promise<Outcome> {
    return this.end(tenantId, reservationId, 'EXPIRED');
  }

  /**
   * Filet de sécurité : expire les réservations échues de toutes les entreprises (jobs perdus ou en retard).
   * La recherche passe par une fonction SQL qui ne révèle que l'identifiant et l'entreprise ; chaque expiration
   * se fait ensuite dans le contexte de son entreprise.
   */
  async sweepExpired(batch = 100): Promise<number> {
    const due = await this.prisma.$queryRaw<
      { reservation_id: string; tenant_id: string }[]
    >`
      SELECT reservation_id, tenant_id FROM expired_reservations(${batch}::integer)`;
    let expired = 0;
    for (const row of due) {
      const outcome = await this.expire(row.tenant_id, row.reservation_id);
      if (outcome.changed) expired++;
    }
    return expired;
  }

  async get(
    tenantId: string,
    reservationId: string,
  ): Promise<ReservationWithItems> {
    return this.tenants.run(tenantId, (tx) => load(tx, reservationId));
  }

  private end(
    tenantId: string,
    reservationId: string,
    status: EndStatus,
  ): Promise<Outcome> {
    return this.tenants.run(tenantId, async (tx) => {
      const won =
        status === 'EXPIRED'
          ? await tx.$queryRaw<{ id: string }[]>`
              UPDATE reservations SET status = 'EXPIRED'::"ReservationStatus", ended_at = now()
              WHERE id = ${reservationId}::uuid AND status = 'ACTIVE'::"ReservationStatus" AND expires_at <= now()
              RETURNING id`
          : await tx.$queryRaw<{ id: string }[]>`
              UPDATE reservations SET status = 'RELEASED'::"ReservationStatus", ended_at = now()
              WHERE id = ${reservationId}::uuid AND status = 'ACTIVE'::"ReservationStatus"
              RETURNING id`;
      const reservation = await load(tx, reservationId);
      if (won.length === 0) {
        // Déjà terminée, confirmée, ou pas encore échue : rien à rendre, et surtout pas deux fois.
        if (status === 'RELEASED' && reservation.status === 'CONFIRMED') {
          throw new ReservationNotActiveError(
            reservationId,
            reservation.status,
          );
        }
        return { reservation, changed: false };
      }
      for (const item of sortedItems(reservation)) {
        await tx.$executeRaw`
          UPDATE stock_items
          SET quantity_reserved = quantity_reserved - ${item.quantity}, version = version + 1, updated_at = now()
          WHERE id = ${item.stockItemId}::uuid`;
      }
      return { reservation, changed: true };
    });
  }

  private async scheduleExpiry(
    tenantId: string,
    reservation: ReservationWithItems,
  ): Promise<void> {
    if (!this.scheduler) return;
    try {
      await this.scheduler.schedule(
        tenantId,
        reservation.id,
        reservation.expiresAt,
      );
    } catch (error) {
      // Réservation valide quand même : le balayage périodique l'expirera.
      this.logger.warn(
        `Expiration de ${reservation.id} non planifiée (${(error as Error).message}) : le balayage la rattrapera`,
      );
    }
  }
}

function mergeLines(items: ReserveLine[]): ReserveLine[] {
  const merged = new Map<string, number>();
  for (const item of items)
    merged.set(
      item.variantId,
      (merged.get(item.variantId) ?? 0) + item.quantity,
    );
  return [...merged].map(([variantId, quantity]) => ({ variantId, quantity }));
}

function sortedItems(reservation: ReservationWithItems): ReservationItem[] {
  return [...reservation.items].sort((a, b) =>
    a.stockItemId.localeCompare(b.stockItemId),
  );
}

function findByReference(
  tx: TenantTransaction,
  tenantId: string,
  reference: string,
) {
  return tx.reservation.findUnique({
    where: { tenantId_reference: { tenantId, reference } },
    include: { items: true },
  });
}

async function load(
  tx: TenantTransaction,
  reservationId: string,
): Promise<ReservationWithItems> {
  const reservation = await tx.reservation.findUnique({
    where: { id: reservationId },
    include: { items: true },
  });
  if (!reservation) throw new ReservationNotFoundError(reservationId);
  return reservation;
}
