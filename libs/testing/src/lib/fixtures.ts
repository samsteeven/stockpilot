/**
 * Données de test, écrites avec le rôle propriétaire (hors Row-Level Security) : chaque appel crée une entreprise
 * neuve, avec ses entrepôts, ses articles et leur stock. Les tests lisent et écrivent ensuite avec le rôle
 * applicatif, comme l'API.
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

export function ownerPool(): Pool {
  return new Pool({
    connectionString: required('STOCKPILOT_TEST_DATABASE_URL'),
    max: 4,
  });
}

export function appDatabaseUrl(): string {
  return required('STOCKPILOT_TEST_APP_DATABASE_URL');
}

export function redisUrl(): string {
  return required('STOCKPILOT_TEST_REDIS_URL');
}

export interface TenantFixture {
  tenantId: string;
  warehouses: Record<string, string>;
  variants: Record<string, string>;
  stockItems: Record<string, string>;
}

/** stock : { "PAR:CASQUE": 5 } = 5 casques à Paris. */
/**
 * existingTenantId : remplit une entreprise déjà créée (par exemple par l'inscription via l'API) au lieu d'en
 * créer une.
 */
export async function createTenant(
  pool: Pool,
  stock: Record<string, number>,
  existingTenantId?: string,
): Promise<TenantFixture> {
  const tenantId = existingTenantId ?? randomUUID();
  const suffix = tenantId.slice(0, 8);
  if (!existingTenantId) {
    await pool.query(
      'INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)',
      [tenantId, `Test ${suffix}`, `t-${suffix}`],
    );
  }
  const productId = randomUUID();
  await pool.query(
    'INSERT INTO products (id, tenant_id, sku, name) VALUES ($1, $2, $3, $4)',
    [productId, tenantId, 'PRODUIT', 'Produit de test'],
  );
  const fixture: TenantFixture = {
    tenantId,
    warehouses: {},
    variants: {},
    stockItems: {},
  };
  for (const [key, quantity] of Object.entries(stock)) {
    const [warehouseCode, sku] = key.split(':');
    if (!fixture.warehouses[warehouseCode]) {
      fixture.warehouses[warehouseCode] = randomUUID();
      await pool.query(
        'INSERT INTO warehouses (id, tenant_id, code, name) VALUES ($1, $2, $3, $3)',
        [fixture.warehouses[warehouseCode], tenantId, warehouseCode],
      );
    }
    if (!fixture.variants[sku]) {
      fixture.variants[sku] = randomUUID();
      await pool.query(
        'INSERT INTO product_variants (id, tenant_id, product_id, sku, name) VALUES ($1, $2, $3, $4, $4)',
        [fixture.variants[sku], tenantId, productId, sku],
      );
    }
    const stockItemId = randomUUID();
    fixture.stockItems[key] = stockItemId;
    await pool.query(
      'INSERT INTO stock_items (id, tenant_id, warehouse_id, variant_id, quantity_on_hand, updated_at) VALUES ($1, $2, $3, $4, $5, now())',
      [
        stockItemId,
        tenantId,
        fixture.warehouses[warehouseCode],
        fixture.variants[sku],
        quantity,
      ],
    );
  }
  return fixture;
}

export async function stockOf(
  pool: Pool,
  stockItemId: string,
): Promise<{ onHand: number; reserved: number }> {
  const { rows } = await pool.query(
    'SELECT quantity_on_hand, quantity_reserved FROM stock_items WHERE id = $1',
    [stockItemId],
  );
  return {
    onHand: rows[0].quantity_on_hand,
    reserved: rows[0].quantity_reserved,
  };
}

/** Avance l'échéance d'une réservation dans le passé, comme si le temps avait passé. */
export async function expireNow(
  pool: Pool,
  reservationId: string,
): Promise<void> {
  await pool.query(
    "UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = $1",
    [reservationId],
  );
}

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `${name} absente : le globalSetup de Jest ne s'est pas exécuté`,
    );
  return value;
}
