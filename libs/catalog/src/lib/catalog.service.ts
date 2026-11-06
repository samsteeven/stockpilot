import { Injectable } from '@nestjs/common';
import { isUniqueViolation, TenantDatabase } from '@stockpilot/database';
import {
  DuplicateSkuError,
  DuplicateWarehouseCodeError,
  ProductNotFoundError,
} from './errors.js';

export interface VariantInput {
  sku: string;
  name: string;
  /** Prix unitaire, décimal en chaîne (« 129.90 ») : jamais de nombre flottant pour de l'argent. */
  unitPrice?: string;
  currency?: string;
}

export interface VariantView {
  id: string;
  sku: string;
  name: string;
  unitPrice: string;
  currency: string;
}

export interface ProductView {
  id: string;
  sku: string;
  name: string;
  active: boolean;
  createdAt: Date;
  variants: VariantView[];
}

export interface WarehouseView {
  id: string;
  code: string;
  name: string;
}

export interface Page<T> {
  items: T[];
  /** À renvoyer pour la page suivante ; absent sur la dernière page. */
  nextCursor?: string;
}

/**
 * Catalogue et entrepôts. Chaque lecture et chaque écriture passent par le contexte de l'entreprise : la
 * Row-Level Security garantit qu'aucun produit d'une autre entreprise n'est lu ni référencé, et les références
 * (SKU, code d'entrepôt) ne sont uniques qu'au sein d'une entreprise.
 */
@Injectable()
export class CatalogService {
  constructor(private readonly db: TenantDatabase) {}

  async createProduct(
    tenantId: string,
    input: { sku: string; name: string; variants: VariantInput[] },
  ): Promise<ProductView> {
    try {
      return await this.db.run(tenantId, async (tx) => {
        const product = await tx.product.create({
          data: { tenantId, sku: input.sku.trim(), name: input.name.trim() },
        });
        await tx.productVariant.createMany({
          data: input.variants.map((v) => ({
            tenantId,
            productId: product.id,
            sku: v.sku.trim(),
            name: v.name.trim(),
            ...price(v),
          })),
        });
        return view(
          await tx.product.findUniqueOrThrow({
            where: { id: product.id },
            include: { variants: { orderBy: { sku: 'asc' } } },
          }),
        );
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new DuplicateSkuError(duplicateSku(error, input) ?? input.sku);
      throw error;
    }
  }

  async addVariant(
    tenantId: string,
    productId: string,
    variant: VariantInput,
  ): Promise<ProductView> {
    try {
      return await this.db.run(tenantId, async (tx) => {
        const product = await tx.product.findUnique({
          where: { id: productId },
          select: { id: true },
        });
        if (!product) throw new ProductNotFoundError();
        await tx.productVariant.create({
          data: {
            tenantId,
            productId,
            sku: variant.sku.trim(),
            name: variant.name.trim(),
            ...price(variant),
          },
        });
        return view(
          await tx.product.findUniqueOrThrow({
            where: { id: productId },
            include: { variants: { orderBy: { sku: 'asc' } } },
          }),
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateSkuError(variant.sku);
      throw error;
    }
  }

  /**
   * Pagination par curseur (sur l'identifiant, dans l'ordre de création) : stable même si des produits sont
   * ajoutés entre deux pages, et sans OFFSET qui relit tout ce qui précède.
   */
  async listProducts(
    tenantId: string,
    options: { limit: number; cursor?: string; search?: string },
  ): Promise<Page<ProductView>> {
    const rows = await this.db.run(tenantId, (tx) =>
      tx.product.findMany({
        where: options.search
          ? {
              OR: [
                { sku: { contains: options.search, mode: 'insensitive' } },
                { name: { contains: options.search, mode: 'insensitive' } },
              ],
            }
          : undefined,
        include: { variants: { orderBy: { sku: 'asc' } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: options.limit + 1,
        ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      }),
    );
    const items = rows.slice(0, options.limit).map(view);
    return {
      items,
      nextCursor:
        rows.length > options.limit ? items[items.length - 1].id : undefined,
    };
  }

  async createWarehouse(
    tenantId: string,
    input: { code: string; name: string },
  ): Promise<WarehouseView> {
    const code = input.code.trim().toUpperCase();
    try {
      return await this.db.run(tenantId, (tx) =>
        tx.warehouse.create({
          data: { tenantId, code, name: input.name.trim() },
          select: { id: true, code: true, name: true },
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateWarehouseCodeError(code);
      throw error;
    }
  }

  listWarehouses(tenantId: string): Promise<WarehouseView[]> {
    return this.db.run(tenantId, (tx) =>
      tx.warehouse.findMany({
        select: { id: true, code: true, name: true },
        orderBy: { code: 'asc' },
      }),
    );
  }
}

function view(product: {
  id: string;
  sku: string;
  name: string;
  active: boolean;
  createdAt: Date;
  variants: {
    id: string;
    sku: string;
    name: string;
    unitPrice: { toFixed(digits: number): string };
    currency: string;
  }[];
}): ProductView {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    active: product.active,
    createdAt: product.createdAt,
    variants: product.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      name: v.name,
      unitPrice: v.unitPrice.toFixed(2),
      currency: v.currency,
    })),
  };
}

function price(variant: VariantInput) {
  return {
    ...(variant.unitPrice !== undefined
      ? { unitPrice: variant.unitPrice }
      : {}),
    ...(variant.currency !== undefined
      ? { currency: variant.currency.toUpperCase() }
      : {}),
  };
}

function duplicateSku(
  error: unknown,
  input: { sku: string; variants: VariantInput[] },
): string | undefined {
  const seen = new Set<string>();
  for (const v of input.variants) {
    if (seen.has(v.sku)) return v.sku;
    seen.add(v.sku);
  }
  return String((error as { message?: string }).message ?? '').includes(
    'product_variants',
  )
    ? input.variants[0]?.sku
    : undefined;
}
