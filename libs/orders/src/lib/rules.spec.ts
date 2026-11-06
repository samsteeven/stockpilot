/**
 * Règles tenues par la base et par la signature, indépendamment du code des services : statuts finaux, journaux
 * en ajout seulement (même pour le propriétaire des tables), droits du rôle applicatif, signature HMAC.
 */
import { randomUUID } from 'node:crypto';
import { createTenant, ownerPool } from '@stockpilot/testing';
import type { Pool } from 'pg';
import { InvalidSignatureError } from './errors.js';
import { signPayload, verifySignature } from './signature.js';

const SECRET = 'secret-de-test-du-prestataire-de-paiement-0123';

describe('signature des notifications', () => {
  const body = Buffer.from('{"id":"evt_1"}');
  const now = 1_800_000_000;

  it('accepte une signature juste et récente', () => {
    expect(() =>
      verifySignature(SECRET, body, signPayload(SECRET, body, now), now + 10),
    ).not.toThrow();
  });

  it.each([
    ['absente', undefined],
    ['mal formée', 't=abc,v1=zz'],
    [
      'autre secret',
      signPayload('autre-secret-tout-aussi-long-que-le-vrai', body, now),
    ],
    ['corps modifié', signPayload(SECRET, '{"id":"evt_2"}', now)],
    [
      'horodatage modifié',
      signPayload(SECRET, body, now).replace(`t=${now}`, `t=${now + 1}`),
    ],
    ['trop ancienne', signPayload(SECRET, body, now - 301)],
    ['trop dans le futur', signPayload(SECRET, body, now + 301)],
  ])('refuse une signature %s', (_, header) => {
    expect(() => verifySignature(SECRET, body, header, now)).toThrow(
      InvalidSignatureError,
    );
  });
});

describe('règles de la base', () => {
  let pool: Pool;
  let tenantId: string;
  let warehouseId: string;
  let userId: string;

  beforeAll(async () => {
    pool = ownerPool();
    const fixture = await createTenant(pool, { 'PAR:CASQUE': 1 });
    tenantId = fixture.tenantId;
    warehouseId = fixture.warehouses.PAR;
    userId = randomUUID();
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function newOrder(status = 'PENDING_PAYMENT'): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO orders (id, tenant_id, warehouse_id, status, currency, total_amount, created_by, cancel_reason)
       VALUES ($1, $2, $3, $4, 'EUR', 10, $5, $6)`,
      [
        id,
        tenantId,
        warehouseId,
        status,
        userId,
        status === 'CANCELLED' ? 'test' : null,
      ],
    );
    return id;
  }

  it('une commande confirmée ou annulée ne change plus de statut, même par le propriétaire des tables', async () => {
    const confirmed = await newOrder('CONFIRMED');
    await expect(
      pool.query(
        "UPDATE orders SET status = 'CANCELLED', cancel_reason = 'x' WHERE id = $1",
        [confirmed],
      ),
    ).rejects.toThrow(/statut final/);
    const cancelled = await newOrder('CANCELLED');
    await expect(
      pool.query(
        "UPDATE orders SET status = 'PENDING_PAYMENT', cancel_reason = NULL WHERE id = $1",
        [cancelled],
      ),
    ).rejects.toThrow(/statut final/);
    const pending = await newOrder();
    await pool.query("UPDATE orders SET status = 'CONFIRMED' WHERE id = $1", [
      pending,
    ]);
  });

  it('une commande annulée a toujours une raison, et seulement elle', async () => {
    await expect(
      newOrder('CANCELLED').then(async (id) => {
        await pool.query(
          'UPDATE orders SET cancel_reason = NULL WHERE id = $1',
          [id],
        );
      }),
    ).rejects.toThrow(/orders_cancel_reason/);
  });

  it('un paiement réglé ne change plus', async () => {
    const orderId = await newOrder();
    const paymentId = randomUUID();
    await pool.query(
      `INSERT INTO payments (id, tenant_id, order_id, status, amount, currency, provider_reference, settled_at)
       VALUES ($1, $2, $3, 'SUCCEEDED', 10, 'EUR', $4, now())`,
      [paymentId, tenantId, orderId, `pay_${randomUUID()}`],
    );
    await expect(
      pool.query("UPDATE payments SET status = 'FAILED' WHERE id = $1", [
        paymentId,
      ]),
    ).rejects.toThrow(/statut final/);
  });

  it('audit et historique : ni modification ni suppression, même par le propriétaire des tables', async () => {
    const orderId = await newOrder();
    await pool.query(
      `INSERT INTO audit_logs (id, tenant_id, action, resource_type) VALUES ($1, $2, 'test.action', 'test')`,
      [randomUUID(), tenantId],
    );
    await pool.query(
      `INSERT INTO order_status_history (id, tenant_id, order_id, to_status) VALUES ($1, $2, $3, 'PENDING_PAYMENT')`,
      [randomUUID(), tenantId, orderId],
    );
    for (const sql of [
      "UPDATE audit_logs SET action = 'efface' WHERE tenant_id = $1",
      'DELETE FROM audit_logs WHERE tenant_id = $1',
      "UPDATE order_status_history SET reason = 'efface' WHERE tenant_id = $1",
      'DELETE FROM order_status_history WHERE tenant_id = $1',
    ]) {
      await expect(pool.query(sql, [tenantId])).rejects.toThrow(
        /ajout seulement/,
      );
    }
  });

  it('le rôle applicatif n’a ni UPDATE ni DELETE sur le journal d’audit', async () => {
    const { rows } = await pool.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'stockpilot_runtime' AND table_name = 'audit_logs' ORDER BY privilege_type`,
    );
    expect(rows.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });
});
