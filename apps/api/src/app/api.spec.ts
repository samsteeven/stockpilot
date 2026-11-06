/**
 * Stock et réservations en HTTP, contre PostgreSQL et Redis réels : validation, codes de réponse, format des
 * erreurs, isolation. Chaque entreprise est créée par une vraie inscription, puis son stock est rempli.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { RESERVATION_EXPIRY_QUEUE } from '@stockpilot/inventory';
import {
  createTenant,
  ownerPool,
  stockOf,
  type TenantFixture,
} from '@stockpilot/testing';
import type { Queue } from 'bullmq';
import type { Pool } from 'pg';
import { type Account, type Http, signUp, startApi } from './testing';

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

async function shop(stock: Record<string, number>): Promise<Shop> {
  const account = await signUp(http);
  return { account, stock: await createTenant(pool, stock, account.tenantId) };
}

function reserveBody(
  s: Shop,
  quantity: number,
  reference = `commande-${randomUUID()}`,
) {
  return {
    reference,
    warehouseId: s.stock.warehouses.PAR,
    items: [{ variantId: s.stock.variants.CASQUE, quantity }],
  };
}

describe('réservations', () => {
  it('réserve (201), rejoue sans effet (200, même réservation) et planifie l’expiration', async () => {
    const s = await shop({ 'PAR:CASQUE': 10 });
    const body = reserveBody(s, 4);

    const first = await http
      .post('/api/v1/reservations')
      .set(s.account.headers)
      .send(body)
      .expect(201);
    const replay = await http
      .post('/api/v1/reservations')
      .set(s.account.headers)
      .send(body)
      .expect(200);

    expect(first.body).toMatchObject({
      status: 'ACTIVE',
      reference: body.reference,
      items: [{ quantity: 4 }],
    });
    expect(replay.body.id).toBe(first.body.id);
    expect(await stockOf(pool, s.stock.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 10,
      reserved: 4,
    });
    const queue = app.get<Queue>(getQueueToken(RESERVATION_EXPIRY_QUEUE));
    const job = await queue.getJob(`expire-${first.body.id}`);
    expect(job?.data).toEqual({
      tenantId: s.account.tenantId,
      reservationId: first.body.id,
    });
    expect(await job?.isDelayed()).toBe(true);
  });

  it('stock insuffisant : 409 au format Problem Details, avec le détail du manque', async () => {
    const s = await shop({ 'PAR:CASQUE': 2 });

    const response = await http
      .post('/api/v1/reservations')
      .set(s.account.headers)
      .send(reserveBody(s, 3))
      .expect(409);

    expect(response.headers['content-type']).toMatch(
      /application\/problem\+json/,
    );
    expect(response.body).toMatchObject({
      title: 'Stock insuffisant',
      status: 409,
      shortages: [
        { variantId: s.stock.variants.CASQUE, requested: 3, available: 2 },
      ],
    });
  });

  it('confirmer (200), puis libérer : 409, la réservation est déjà confirmée', async () => {
    const s = await shop({ 'PAR:CASQUE': 10 });
    const { body } = await http
      .post('/api/v1/reservations')
      .set(s.account.headers)
      .send(reserveBody(s, 4))
      .expect(201);

    const confirmed = await http
      .post(`/api/v1/reservations/${body.id}/confirm`)
      .set(s.account.headers)
      .expect(200);
    const release = await http
      .post(`/api/v1/reservations/${body.id}/release`)
      .set(s.account.headers)
      .expect(409);

    expect(confirmed.body.status).toBe('CONFIRMED');
    expect(release.body.reservationStatus).toBe('CONFIRMED');
    const stock = await http
      .get('/api/v1/inventory')
      .set(s.account.headers)
      .expect(200);
    expect(stock.body).toEqual([
      expect.objectContaining({
        sku: 'CASQUE',
        onHand: 6,
        reserved: 0,
        available: 6,
      }),
    ]);
  });

  it('réception de marchandise : le stock augmente et le mouvement est tracé', async () => {
    const s = await shop({ 'PAR:CASQUE': 1 });

    const response = await http
      .post('/api/v1/inventory/receipts')
      .set(s.account.headers)
      .send({
        warehouseId: s.stock.warehouses.PAR,
        variantId: s.stock.variants.CASQUE,
        quantity: 9,
      })
      .expect(201);

    expect(response.body).toMatchObject({ onHand: 10, available: 10 });
    const { rows } = await pool.query(
      "SELECT quantity FROM stock_movements WHERE stock_item_id = $1 AND type = 'RECEIPT'",
      [s.stock.stockItems['PAR:CASQUE']],
    );
    expect(rows).toEqual([{ quantity: 9 }]);
  });

  it('un article créé par l’API reçoit du stock dans un entrepôt créé par l’API, puis se réserve', async () => {
    const account = await signUp(http);
    const warehouse = await http
      .post('/api/v1/warehouses')
      .set(account.headers)
      .send({ code: 'LYO', name: 'Lyon' })
      .expect(201);
    const product = await http
      .post('/api/v1/products')
      .set(account.headers)
      .send({
        sku: 'LAMPE',
        name: 'Lampe',
        variants: [{ sku: 'LAMPE-LAITON', name: 'Laiton' }],
      })
      .expect(201);
    const variantId = product.body.variants[0].id;

    await http
      .post('/api/v1/inventory/receipts')
      .set(account.headers)
      .send({ warehouseId: warehouse.body.id, variantId, quantity: 3 })
      .expect(201);
    await http
      .post('/api/v1/reservations')
      .set(account.headers)
      .send({
        reference: 'commande-1',
        warehouseId: warehouse.body.id,
        items: [{ variantId, quantity: 3 }],
      })
      .expect(201);

    const stock = await http
      .get('/api/v1/inventory')
      .set(account.headers)
      .expect(200);
    expect(stock.body).toEqual([
      expect.objectContaining({
        sku: 'LAMPE-LAITON',
        onHand: 3,
        reserved: 3,
        available: 0,
      }),
    ]);
  });
});

describe('entrées refusées', () => {
  it.each([
    ['quantité nulle', { quantity: 0 }],
    ['quantité décimale', { quantity: 1.5 }],
    ['champ inconnu', { quantity: 1, prix: 0 }],
  ])('%s : 400', async (_, item) => {
    const s = await shop({ 'PAR:CASQUE': 1 });
    const body = {
      reference: 'x',
      warehouseId: s.stock.warehouses.PAR,
      items: [{ variantId: s.stock.variants.CASQUE, ...item }],
    };

    const response = await http
      .post('/api/v1/reservations')
      .set(s.account.headers)
      .send(body)
      .expect(400);

    expect(response.body.status).toBe(400);
  });

  it('identifiant mal formé dans l’URL : 400, sans requête en base', async () => {
    const s = await shop({ 'PAR:CASQUE': 1 });
    await http
      .get('/api/v1/reservations/pas-un-uuid')
      .set(s.account.headers)
      .expect(400);
  });
});

describe('isolation entre entreprises', () => {
  it('la réservation d’une autre entreprise répond 404, jamais 403', async () => {
    const a = await shop({ 'PAR:CASQUE': 10 });
    const b = await shop({ 'PAR:CASQUE': 10 });
    const { body } = await http
      .post('/api/v1/reservations')
      .set(a.account.headers)
      .send(reserveBody(a, 1))
      .expect(201);

    await http
      .get(`/api/v1/reservations/${body.id}`)
      .set(b.account.headers)
      .expect(404);
    await http
      .post(`/api/v1/reservations/${body.id}/confirm`)
      .set(b.account.headers)
      .expect(404);
    const stockB = await http
      .get('/api/v1/inventory')
      .set(b.account.headers)
      .expect(200);
    expect(
      stockB.body.map((s: { stockItemId: string }) => s.stockItemId),
    ).toEqual([b.stock.stockItems['PAR:CASQUE']]);
  });

  it('réserver dans l’entrepôt d’une autre entreprise : 422, rien n’est réservé', async () => {
    const a = await shop({ 'PAR:CASQUE': 10 });
    const b = await shop({ 'PAR:CASQUE': 10 });

    await http
      .post('/api/v1/reservations')
      .set(b.account.headers)
      .send(reserveBody(a, 1))
      .expect(422);

    expect(await stockOf(pool, a.stock.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 10,
      reserved: 0,
    });
  });
});

describe('santé', () => {
  it('vivant et prêt, sans authentification', async () => {
    await http.get('/health').expect(200, { status: 'ok' });
    await http.get('/health/ready').expect(200, { status: 'ok' });
  });
});
