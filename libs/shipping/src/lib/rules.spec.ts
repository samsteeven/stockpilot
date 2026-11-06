/**
 * Règles tenues par la base pour les expéditions et les messages, quelle que soit la requête : statut qui n'avance
 * que dans un sens, suivi obligatoire une fois expédiée, isolation entre entreprises.
 */
import { randomUUID } from 'node:crypto';
import { createTenant, ownerPool } from '@stockpilot/testing';
import type { Pool } from 'pg';

let pool: Pool;
let tenantId: string;
let warehouseId: string;

beforeAll(async () => {
  pool = ownerPool();
  const fixture = await createTenant(pool, { 'PAR:CASQUE': 1 });
  tenantId = fixture.tenantId;
  warehouseId = fixture.warehouses.PAR;
});

afterAll(async () => {
  await pool?.end();
});

async function newShipment(): Promise<string> {
  const orderId = randomUUID();
  await pool.query(
    `INSERT INTO orders (id, tenant_id, warehouse_id, status, currency, total_amount, created_by)
     VALUES ($1, $2, $3, 'CONFIRMED', 'EUR', 10, $4)`,
    [orderId, tenantId, warehouseId, randomUUID()],
  );
  const id = randomUUID();
  await pool.query(
    'INSERT INTO shipments (id, tenant_id, order_id, warehouse_id) VALUES ($1, $2, $3, $4)',
    [id, tenantId, orderId, warehouseId],
  );
  return id;
}

const SHIP = `UPDATE shipments SET status = 'SHIPPED', carrier = 'Colissimo', tracking_number = 'X1234',
              shipped_at = now() WHERE id = $1`;

it('expédiée sans transporteur ni suivi : refusé', async () => {
  const id = await newShipment();
  await expect(
    pool.query(
      "UPDATE shipments SET status = 'SHIPPED', shipped_at = now() WHERE id = $1",
      [id],
    ),
  ).rejects.toThrow(/shipments_shipped_details/);
});

it('pas de saut ni de retour : prête → livrée, livrée → expédiée, expédiée → prête', async () => {
  const id = await newShipment();
  await expect(
    pool.query(
      "UPDATE shipments SET status = 'DELIVERED', delivered_at = now() WHERE id = $1",
      [id],
    ),
  ).rejects.toThrow(/interdit/);
  await pool.query(SHIP, [id]);
  await expect(
    pool.query("UPDATE shipments SET status = 'READY_TO_SHIP' WHERE id = $1", [
      id,
    ]),
  ).rejects.toThrow(/interdit/);
  await pool.query(
    "UPDATE shipments SET status = 'DELIVERED', delivered_at = now() WHERE id = $1",
    [id],
  );
  await expect(
    pool.query(
      "UPDATE shipments SET status = 'SHIPPED', delivered_at = NULL WHERE id = $1",
      [id],
    ),
  ).rejects.toThrow(/interdit/);
});

it('une seule expédition par commande', async () => {
  const id = await newShipment();
  const { rows } = await pool.query(
    'SELECT order_id FROM shipments WHERE id = $1',
    [id],
  );
  await expect(
    pool.query(
      'INSERT INTO shipments (id, tenant_id, order_id, warehouse_id) VALUES ($1, $2, $3, $4)',
      [randomUUID(), tenantId, rows[0].order_id, warehouseId],
    ),
  ).rejects.toThrow(/unique/);
});

it('expéditions et messages sous Row-Level Security', async () => {
  const { rows } = await pool.query(
    `SELECT relname FROM pg_class WHERE relname IN ('shipments', 'notifications')
       AND relrowsecurity AND relforcerowsecurity ORDER BY relname`,
  );
  expect(rows.map((r) => r.relname)).toEqual(['notifications', 'shipments']);
});
