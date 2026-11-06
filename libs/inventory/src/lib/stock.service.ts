import { Injectable } from '@nestjs/common';
import { StockMovementType, TenantDatabase } from '@stockpilot/database';
import { UnknownStockItemError } from './errors.js';

export interface StockLevel {
  stockItemId: string;
  warehouseId: string;
  variantId: string;
  sku: string;
  onHand: number;
  reserved: number;
  available: number;
}

@Injectable()
export class StockService {
  constructor(private readonly tenants: TenantDatabase) {}

  /** Entrée de marchandise : la ligne de stock est créée au besoin, le mouvement est enregistré avec elle. */
  async receive(
    tenantId: string,
    input: {
      warehouseId: string;
      variantId: string;
      quantity: number;
      referenceId?: string;
    },
  ): Promise<StockLevel> {
    return this.tenants.run(tenantId, async (tx) => {
      // Les clés composites (tenant_id, id) refusent un entrepôt ou un article d'une autre entreprise ; la RLS les
      // rend de toute façon invisibles. On vérifie d'abord pour répondre clairement.
      const variant = await tx.productVariant.findUnique({
        where: { id: input.variantId },
        select: { id: true },
      });
      const warehouse = await tx.warehouse.findUnique({
        where: { id: input.warehouseId },
        select: { id: true },
      });
      if (!variant || !warehouse)
        throw new UnknownStockItemError(input.variantId);

      const item = await tx.stockItem.upsert({
        where: {
          tenantId_warehouseId_variantId: {
            tenantId,
            warehouseId: input.warehouseId,
            variantId: input.variantId,
          },
        },
        create: {
          tenantId,
          warehouseId: input.warehouseId,
          variantId: input.variantId,
          quantityOnHand: input.quantity,
        },
        update: {
          quantityOnHand: { increment: input.quantity },
          version: { increment: 1 },
        },
      });
      await tx.stockMovement.create({
        data: {
          tenantId,
          stockItemId: item.id,
          type: StockMovementType.RECEIPT,
          quantity: input.quantity,
          referenceId: input.referenceId ?? null,
        },
      });
      const [level] = await levels(tx, { stockItemId: item.id });
      return level;
    });
  }

  list(tenantId: string, warehouseId?: string): Promise<StockLevel[]> {
    return this.tenants.run(tenantId, (tx) => levels(tx, { warehouseId }));
  }
}

async function levels(
  tx: Parameters<Parameters<TenantDatabase['run']>[1]>[0],
  filter: { warehouseId?: string; stockItemId?: string },
): Promise<StockLevel[]> {
  const items = await tx.stockItem.findMany({
    where: { warehouseId: filter.warehouseId, id: filter.stockItemId },
    include: { variant: { select: { sku: true } } },
    orderBy: [{ warehouseId: 'asc' }, { variant: { sku: 'asc' } }],
  });
  return items.map((item) => ({
    stockItemId: item.id,
    warehouseId: item.warehouseId,
    variantId: item.variantId,
    sku: item.variant.sku,
    onHand: item.quantityOnHand,
    reserved: item.quantityReserved,
    available: item.quantityOnHand - item.quantityReserved,
  }));
}
