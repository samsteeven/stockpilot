/**
 * Expéditions et messages en HTTP : l'expédition d'une commande confirmée (créée comme le ferait le worker),
 * expédier puis livrer, transitions refusées, rejeu, permissions, isolation ; permissions exposées au front.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { signPayload } from '@stockpilot/orders';
import { ShipmentService } from '@stockpilot/shipping';
import {
  createTenant,
  ownerPool,
  type TenantFixture,
} from '@stockpilot/testing';
import type { Pool } from 'pg';
import {
  type Account,
  type Http,
  joinAs,
  signUp,
  startApi,
  WEBHOOK_SECRET,
} from './testing';

let app: INestApplication;
let pool: Pool;
let http: Http;

beforeAll(async () => {
  pool = ownerPool();
  ({ app, http } = await startApi());
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

interface Shop {
  account: Account;
  stock: TenantFixture;
}

async function shop(): Promise<Shop> {
  const account = await signUp(http);
  const stock = await createTenant(
    pool,
    { 'PAR:CASQUE': 10 },
    account.tenantId,
  );
  await pool.query(
    "UPDATE product_variants SET unit_price = '20.00' WHERE id = $1",
    [stock.variants.CASQUE],
  );
  return { account, stock };
}

/** Commande payée, puis expédition créée comme le ferait le worker à la réception de « commande confirmée ». */
async function confirmedShipment(
  s: Shop,
): Promise<{ orderId: string; shipmentId: string }> {
  const { body: order } = await http
    .post('/api/v1/orders')
    .set(s.account.headers)
    .set('Idempotency-Key', randomUUID())
    .send({
      warehouseId: s.stock.warehouses.PAR,
      items: [{ variantId: s.stock.variants.CASQUE, quantity: 1 }],
      customerEmail: 'client@example.com',
    })
    .expect(201);
  const notification = JSON.stringify({
    id: `evt_${randomUUID()}`,
    type: 'payment.succeeded',
    data: {
      providerReference: order.payment.providerReference,
      amount: '20.00',
      currency: 'EUR',
    },
  });
  await http
    .post('/api/v1/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('Stockpilot-Signature', signPayload(WEBHOOK_SECRET, notification))
    .send(notification)
    .expect(200);
  const outcome = await app
    .get(ShipmentService)
    .onOrderConfirmed(randomUUID(), s.account.tenantId, order.id);
  expect(outcome).toBe('created');
  const { body: details } = await http
    .get(`/api/v1/orders/${order.id}`)
    .set(s.account.headers)
    .expect(200);
  return { orderId: order.id, shipmentId: details.shipment.id };
}

const ship = { carrier: 'Colissimo', trackingNumber: '6A12345678901' };

it('expédier puis livrer ; la commande montre son suivi', async () => {
  const s = await shop();
  const { orderId, shipmentId } = await confirmedShipment(s);

  const shipped = await http
    .post(`/api/v1/shipments/${shipmentId}/ship`)
    .set(s.account.headers)
    .send(ship)
    .expect(200);
  expect(shipped.body).toMatchObject({ status: 'SHIPPED', ...ship });
  const delivered = await http
    .post(`/api/v1/shipments/${shipmentId}/deliver`)
    .set(s.account.headers)
    .expect(200);
  expect(delivered.body.status).toBe('DELIVERED');

  const order = await http
    .get(`/api/v1/orders/${orderId}`)
    .set(s.account.headers)
    .expect(200);
  expect(order.body.shipment).toMatchObject({ status: 'DELIVERED', ...ship });
  const list = await http
    .get('/api/v1/shipments?status=DELIVERED')
    .set(s.account.headers)
    .expect(200);
  expect(list.body.map((x: { id: string }) => x.id)).toEqual([shipmentId]);
});

it('une seule expédition par commande, même si « commande confirmée » arrive deux fois', async () => {
  const s = await shop();
  const { orderId } = await confirmedShipment(s);
  const again = await app
    .get(ShipmentService)
    .onOrderConfirmed(randomUUID(), s.account.tenantId, orderId);
  expect(again).toBe('nothing-to-do');
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM shipments WHERE order_id = $1',
    [orderId],
  );
  expect(rows[0].n).toBe(1);
});

it('livrer avant d’expédier : 409 ; expédier deux fois : même numéro sans effet, autre numéro 409', async () => {
  const s = await shop();
  const { shipmentId } = await confirmedShipment(s);
  await http
    .post(`/api/v1/shipments/${shipmentId}/deliver`)
    .set(s.account.headers)
    .expect(409);
  await http
    .post(`/api/v1/shipments/${shipmentId}/ship`)
    .set(s.account.headers)
    .send(ship)
    .expect(200);
  await http
    .post(`/api/v1/shipments/${shipmentId}/ship`)
    .set(s.account.headers)
    .send(ship)
    .expect(200);
  await http
    .post(`/api/v1/shipments/${shipmentId}/ship`)
    .set(s.account.headers)
    .send({ ...ship, trackingNumber: 'AUTRE-NUMERO' })
    .expect(409);
});

it('une commande non confirmée n’a pas d’expédition', async () => {
  const s = await shop();
  const { body: order } = await http
    .post('/api/v1/orders')
    .set(s.account.headers)
    .set('Idempotency-Key', randomUUID())
    .send({
      warehouseId: s.stock.warehouses.PAR,
      items: [{ variantId: s.stock.variants.CASQUE, quantity: 1 }],
    })
    .expect(201);
  const outcome = await app
    .get(ShipmentService)
    .onOrderConfirmed(randomUUID(), s.account.tenantId, order.id);
  expect(outcome).toBe('nothing-to-do');
});

it('permissions : le responsable d’entrepôt expédie, l’opérateur non ; les messages sont réservés aux administrateurs', async () => {
  const s = await shop();
  const { shipmentId } = await confirmedShipment(s);
  const operator = await joinAs(http, s.account, 'OPERATOR');
  const manager = await joinAs(http, s.account, 'WAREHOUSE_MANAGER');

  await http
    .post(`/api/v1/shipments/${shipmentId}/ship`)
    .set(operator.headers)
    .send(ship)
    .expect(403);
  await http.get('/api/v1/shipments').set(operator.headers).expect(200);
  await http
    .post(`/api/v1/shipments/${shipmentId}/ship`)
    .set(manager.headers)
    .send(ship)
    .expect(200);
  await http.get('/api/v1/notifications').set(manager.headers).expect(403);
  await http.get('/api/v1/notifications').set(s.account.headers).expect(200);
});

it('numéro de suivi invalide : 400', async () => {
  const s = await shop();
  const { shipmentId } = await confirmedShipment(s);
  await http
    .post(`/api/v1/shipments/${shipmentId}/ship`)
    .set(s.account.headers)
    .send({ carrier: 'Colissimo', trackingNumber: '<script>' })
    .expect(400);
});

it('l’expédition d’une autre entreprise : 404', async () => {
  const a = await shop();
  const b = await shop();
  const { shipmentId } = await confirmedShipment(a);
  await http
    .get(`/api/v1/shipments/${shipmentId}`)
    .set(b.account.headers)
    .expect(404);
  await http
    .post(`/api/v1/shipments/${shipmentId}/ship`)
    .set(b.account.headers)
    .send(ship)
    .expect(404);
});

it('le profil donne, pour chaque entreprise, les permissions du rôle', async () => {
  const s = await shop();
  const viewer = await joinAs(http, s.account, 'VIEWER');
  const me = await http
    .get('/api/v1/auth/me')
    .set({ Authorization: `Bearer ${viewer.accessToken}` })
    .expect(200);
  const membership = me.body.tenants.find(
    (t: { tenantId: string }) => t.tenantId === s.account.tenantId,
  );
  expect(membership.permissions).toEqual([
    'members:read',
    'orders:read',
    'stock:read',
  ]);
});
