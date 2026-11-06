/**
 * Commandes, paiement et compensation en HTTP, contre PostgreSQL et Redis réels : Idempotency-Key, prix calculés
 * par le serveur, notification signée du prestataire, paiement refusé, paiement arrivé après l'expiration,
 * annulation, permissions, audit et isolation.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { signPayload } from '@stockpilot/orders';
import {
  createTenant,
  expireNow,
  ownerPool,
  stockOf,
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

/** Une entreprise inscrite par l'API, avec des casques à 49,90 € et des câbles à 9,99 €. */
async function shop(stock: Record<string, number>): Promise<Shop> {
  const account = await signUp(http);
  const fixture = await createTenant(pool, stock, account.tenantId);
  const prices: Record<string, string> = { CASQUE: '49.90', CABLE: '9.99' };
  for (const [sku, id] of Object.entries(fixture.variants)) {
    await pool.query(
      'UPDATE product_variants SET unit_price = $1 WHERE id = $2',
      [prices[sku] ?? '1.00', id],
    );
  }
  return { account, stock: fixture };
}

function orderBody(s: Shop, quantity: number, sku = 'CASQUE') {
  return {
    warehouseId: s.stock.warehouses.PAR,
    items: [{ variantId: s.stock.variants[sku], quantity }],
  };
}

async function place(s: Shop, quantity: number, key = randomUUID()) {
  return http
    .post('/api/v1/orders')
    .set(s.account.headers)
    .set('Idempotency-Key', key)
    .send(orderBody(s, quantity))
    .expect(201);
}

let notificationCounter = 0;

/** Ce qu'enverrait le prestataire de paiement : un corps JSON signé avec le secret partagé. */
function notify(
  providerReference: string,
  type: 'payment.succeeded' | 'payment.failed',
  amount: string,
  options: {
    id?: string;
    currency?: string;
    secret?: string;
    timestamp?: number;
  } = {},
) {
  const body = JSON.stringify({
    id: options.id ?? `evt_${Date.now()}_${++notificationCounter}`,
    type,
    data: { providerReference, amount, currency: options.currency ?? 'EUR' },
  });
  return http
    .post('/api/v1/payments/webhook')
    .set('Content-Type', 'application/json')
    .set(
      'Stockpilot-Signature',
      signPayload(options.secret ?? WEBHOOK_SECRET, body, options.timestamp),
    )
    .send(body);
}

async function orderOf(s: Shop, id: string) {
  return (
    await http.get(`/api/v1/orders/${id}`).set(s.account.headers).expect(200)
  ).body;
}

describe('création et Idempotency-Key', () => {
  it('crée la commande au prix du catalogue, réserve le stock et attend le paiement', async () => {
    const s = await shop({ 'PAR:CASQUE': 5 });
    const { body } = await place(s, 2);

    expect(body).toMatchObject({
      status: 'PENDING_PAYMENT',
      currency: 'EUR',
      totalAmount: '99.80',
      items: [{ quantity: 2, unitPrice: '49.90' }],
      payment: { status: 'PENDING', amount: '99.80', currency: 'EUR' },
    });
    expect(body.payment.providerReference).toMatch(/^pay_[0-9a-f]{24}$/);
    expect(new Date(body.payBefore).getTime()).toBeGreaterThan(Date.now());
    expect(await stockOf(pool, s.stock.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 5,
      reserved: 2,
    });
    const details = await orderOf(s, body.id);
    expect(details.history).toEqual([
      expect.objectContaining({ from: null, to: 'PENDING_PAYMENT' }),
    ]);
  });

  it('sans Idempotency-Key : 400, rien n’est créé', async () => {
    const s = await shop({ 'PAR:CASQUE': 5 });
    await http
      .post('/api/v1/orders')
      .set(s.account.headers)
      .send(orderBody(s, 1))
      .expect(400);
    expect(await stockOf(pool, s.stock.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 5,
      reserved: 0,
    });
  });

  it('le client ne fixe pas le prix : un champ unitPrice est refusé', async () => {
    const s = await shop({ 'PAR:CASQUE': 5 });
    await http
      .post('/api/v1/orders')
      .set(s.account.headers)
      .set('Idempotency-Key', randomUUID())
      .send({
        warehouseId: s.stock.warehouses.PAR,
        items: [
          {
            variantId: s.stock.variants.CASQUE,
            quantity: 1,
            unitPrice: '0.01',
          },
        ],
      })
      .expect(400);
  });

  it('même clé, même commande : la première réponse est rejouée, une seule commande et une seule réservation', async () => {
    const s = await shop({ 'PAR:CASQUE': 5 });
    const key = randomUUID();
    const first = await place(s, 2, key);
    const second = await place(s, 2, key);

    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.body).toEqual(first.body);
    const list = await http
      .get('/api/v1/orders')
      .set(s.account.headers)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(await stockOf(pool, s.stock.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 5,
      reserved: 2,
    });
  });

  it('même clé, autre commande : 422, la première reste seule', async () => {
    const s = await shop({ 'PAR:CASQUE': 5 });
    const key = randomUUID();
    await place(s, 2, key);
    const response = await http
      .post('/api/v1/orders')
      .set(s.account.headers)
      .set('Idempotency-Key', key)
      .send(orderBody(s, 3))
      .expect(422);
    expect(response.body.title).toMatch(/idempotence/);
    expect(await stockOf(pool, s.stock.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 5,
      reserved: 2,
    });
  });

  it('10 requêtes simultanées avec la même clé : une seule commande, toutes reçoivent la même', async () => {
    const s = await shop({ 'PAR:CASQUE': 5 });
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        http
          .post('/api/v1/orders')
          .set(s.account.headers)
          .set('Idempotency-Key', key)
          .send(orderBody(s, 1)),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
    expect(
      responses.filter((r) => r.headers['idempotent-replayed']),
    ).toHaveLength(9);
    expect(await stockOf(pool, s.stock.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 5,
      reserved: 1,
    });
  });

  it('stock insuffisant : 409 et aucune commande (tout ou rien)', async () => {
    const s = await shop({ 'PAR:CASQUE': 1 });
    const response = await http
      .post('/api/v1/orders')
      .set(s.account.headers)
      .set('Idempotency-Key', randomUUID())
      .send(orderBody(s, 2))
      .expect(409);
    expect(response.body.shortages).toEqual([
      expect.objectContaining({ requested: 2, available: 1 }),
    ]);
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1',
      [s.account.tenantId],
    );
    expect(rows[0].n).toBe(0);
  });

  it('article inconnu ou devises mélangées : 422', async () => {
    const s = await shop({ 'PAR:CASQUE': 5, 'PAR:CABLE': 5 });
    await http
      .post('/api/v1/orders')
      .set(s.account.headers)
      .set('Idempotency-Key', randomUUID())
      .send({
        warehouseId: s.stock.warehouses.PAR,
        items: [{ variantId: randomUUID(), quantity: 1 }],
      })
      .expect(422);
    await pool.query(
      "UPDATE product_variants SET currency = 'USD' WHERE id = $1",
      [s.stock.variants.CABLE],
    );
    await http
      .post('/api/v1/orders')
      .set(s.account.headers)
      .set('Idempotency-Key', randomUUID())
      .send({
        warehouseId: s.stock.warehouses.PAR,
        items: [
          { variantId: s.stock.variants.CASQUE, quantity: 1 },
          { variantId: s.stock.variants.CABLE, quantity: 1 },
        ],
      })
      .expect(422);
  });
});

describe('paiement', () => {
  it('paiement accepté : commande confirmée, le stock sort ; la même notification renvoyée est sans effet', async () => {
    const s = await shop({ 'PAR:CASQUE': 5 });
    const { body: order } = await place(s, 2);
    const id = `evt_${randomUUID()}`;

    const first = await notify(
      order.payment.providerReference,
      'payment.succeeded',
      '99.80',
      { id },
    ).expect(200);
    expect(first.body).toEqual({ outcome: 'confirmed', orderId: order.id });
    const again = await notify(
      order.payment.providerReference,
      'payment.succeeded',
      '99.80',
      { id },
    ).expect(200);
    expect(again.body.outcome).toBe('duplicate');
    const other = await notify(
      order.payment.providerReference,
      'payment.succeeded',
      '99.80',
    ).expect(200);
    expect(other.body.outcome).toBe('already-settled');

    const details = await orderOf(s, order.id);
    expect(details.status).toBe('CONFIRMED');
    expect(details.payment.status).toBe('SUCCEEDED');
    expect(details.history.map((h: { to: string }) => h.to)).toEqual([
      'PENDING_PAYMENT',
      'CONFIRMED',
    ]);
    expect(await stockOf(pool, s.stock.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 3,
      reserved: 0,
    });
  });

  it('signature fausse, d’un autre secret ou trop ancienne : 401, rien ne change', async () => {
    const s = await shop({ 'PAR:CASQUE': 5 });
    const { body: order } = await place(s, 1);
    const ref = order.payment.providerReference;

    await notify(ref, 'payment.succeeded', '49.90', {
      secret: 'un-autre-secret-qui-n-est-pas-celui-du-prestataire',
    }).expect(401);
    await notify(ref, 'payment.succeeded', '49.90', {
      timestamp: Math.floor(Date.now() / 1000) - 600,
    }).expect(401);
    await http
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .send({ id: 'evt', type: 'payment.succeeded' })
      .expect(401);
    // Corps modifié après signature.
    const body = JSON.stringify({
      id: 'evt_modifie',
      type: 'payment.succeeded',
      data: { providerReference: ref, amount: '49.90', currency: 'EUR' },
    });
    await http
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('Stockpilot-Signature', signPayload(WEBHOOK_SECRET, body))
      .send(body.replace('49.90', '0.01'))
      .expect(401);

    expect((await orderOf(s, order.id)).status).toBe('PENDING_PAYMENT');
  });

  it('montant différent de celui attendu : 422, la commande attend toujours', async () => {
    const s = await shop({ 'PAR:CASQUE': 5 });
    const { body: order } = await place(s, 1);
    await notify(
      order.payment.providerReference,
      'payment.succeeded',
      '1.00',
    ).expect(422);
    expect((await orderOf(s, order.id)).status).toBe('PENDING_PAYMENT');
  });

  it('référence inconnue : 404', async () => {
    await notify('pay_inconnu', 'payment.succeeded', '1.00').expect(404);
  });

  it('paiement refusé : commande annulée et stock rendu', async () => {
    const s = await shop({ 'PAR:CASQUE': 5 });
    const { body: order } = await place(s, 2);
    const response = await notify(
      order.payment.providerReference,
      'payment.failed',
      '99.80',
    ).expect(200);
    expect(response.body.outcome).toBe('cancelled');

    const details = await orderOf(s, order.id);
    expect(details).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'payment_failed',
      payment: { status: 'FAILED' },
    });
    expect(await stockOf(pool, s.stock.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 5,
      reserved: 0,
    });
  });

  it('paiement arrivé après l’expiration de la réservation : rien ne sort du stock, commande annulée, remboursement exigé', async () => {
    const s = await shop({ 'PAR:CASQUE': 5 });
    const { body: order } = await place(s, 2);
    await expireNow(pool, order.reservationId);

    const response = await notify(
      order.payment.providerReference,
      'payment.succeeded',
      '99.80',
    ).expect(200);
    expect(response.body.outcome).toBe('refund-required');

    const details = await orderOf(s, order.id);
    expect(details).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'reservation_expired',
      payment: { status: 'REFUND_REQUIRED' },
    });
    // Le stock n'est pas sorti ; la réservation échue sera rendue par le worker.
    expect((await stockOf(pool, s.stock.stockItems['PAR:CASQUE'])).onHand).toBe(
      5,
    );
  });
});

describe('annulation', () => {
  it('annuler rend la réservation ; annuler deux fois ne fait rien de plus ; un paiement ensuite exige un remboursement', async () => {
    const s = await shop({ 'PAR:CASQUE': 5 });
    const { body: order } = await place(s, 3);

    const first = await http
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set(s.account.headers)
      .expect(200);
    expect(first.body).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'cancelled_by_user',
    });
    await http
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set(s.account.headers)
      .expect(200);
    expect(await stockOf(pool, s.stock.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 5,
      reserved: 0,
    });

    const paid = await notify(
      order.payment.providerReference,
      'payment.succeeded',
      '149.70',
    ).expect(200);
    expect(paid.body.outcome).toBe('refund-required');
  });

  it('une commande confirmée ne s’annule plus : 409', async () => {
    const s = await shop({ 'PAR:CASQUE': 5 });
    const { body: order } = await place(s, 1);
    await notify(
      order.payment.providerReference,
      'payment.succeeded',
      '49.90',
    ).expect(200);
    await http
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set(s.account.headers)
      .expect(409);
  });
});

describe('permissions, audit et isolation', () => {
  it('un lecteur consulte les commandes mais n’en crée pas ; un opérateur en crée', async () => {
    const s = await shop({ 'PAR:CASQUE': 5 });
    const viewer = await joinAs(http, s.account, 'VIEWER');
    const operator = await joinAs(http, s.account, 'OPERATOR');

    await http
      .post('/api/v1/orders')
      .set(viewer.headers)
      .set('Idempotency-Key', randomUUID())
      .send(orderBody(s, 1))
      .expect(403);
    await http
      .post('/api/v1/orders')
      .set(operator.headers)
      .set('Idempotency-Key', randomUUID())
      .send(orderBody(s, 1))
      .expect(201);
    const list = await http
      .get('/api/v1/orders')
      .set(viewer.headers)
      .expect(200);
    expect(list.body).toHaveLength(1);
  });

  it('le journal d’audit : lisible par le propriétaire, pas par un opérateur', async () => {
    const s = await shop({ 'PAR:CASQUE': 5 });
    const operator = await joinAs(http, s.account, 'OPERATOR');
    const { body: order } = await http
      .post('/api/v1/orders')
      .set(operator.headers)
      .set('Idempotency-Key', randomUUID())
      .send(orderBody(s, 1))
      .expect(201);
    await notify(
      order.payment.providerReference,
      'payment.succeeded',
      '49.90',
    ).expect(200);

    await http.get('/api/v1/audit').set(operator.headers).expect(403);
    const audit = await http
      .get('/api/v1/audit')
      .set(s.account.headers)
      .expect(200);
    const actions = audit.body.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'invitation.created',
        'invitation.accepted',
        'order.created',
        'payment.succeeded',
      ]),
    );
    const created = audit.body.find(
      (e: { action: string }) => e.action === 'order.created',
    );
    expect(created).toMatchObject({
      actorId: operator.userId,
      resourceId: order.id,
    });
    const paid = audit.body.find(
      (e: { action: string }) => e.action === 'payment.succeeded',
    );
    expect(paid.actorId).toBeNull();
  });

  it('la commande d’une autre entreprise : 404, et elle ne peut pas l’annuler', async () => {
    const a = await shop({ 'PAR:CASQUE': 5 });
    const b = await shop({ 'PAR:CASQUE': 5 });
    const { body: order } = await place(a, 1);
    await http
      .get(`/api/v1/orders/${order.id}`)
      .set(b.account.headers)
      .expect(404);
    await http
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set(b.account.headers)
      .expect(404);
    const list = await http
      .get('/api/v1/orders')
      .set(b.account.headers)
      .expect(200);
    expect(list.body).toHaveLength(0);
  });
});
