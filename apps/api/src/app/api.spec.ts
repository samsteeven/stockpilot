/**
 * L'API en HTTP, contre PostgreSQL et Redis réels : validation, codes de réponse, format des erreurs, isolation.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { RESERVATION_EXPIRY_QUEUE } from '@stockpilot/inventory';
import {
  appDatabaseUrl,
  createTenant,
  ownerPool,
  redisUrl,
  stockOf,
  type TenantFixture,
} from '@stockpilot/testing';
import type { Queue } from 'bullmq';
import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from './create-app';

let app: INestApplication;
let pool: Pool;
let http: ReturnType<typeof request>;

beforeAll(async () => {
  pool = ownerPool();
  app = await createApp({
    port: 0,
    appDatabaseUrl: appDatabaseUrl(),
    databasePoolSize: 5,
    redisUrl: redisUrl(),
    reservationTtlSeconds: 900,
  });
  await app.init();
  http = request(app.getHttpServer());
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

const as = (t: TenantFixture) => ({ 'X-Tenant-Id': t.tenantId });

function reserveBody(
  t: TenantFixture,
  quantity: number,
  reference = `commande-${randomUUID()}`,
) {
  return {
    reference,
    warehouseId: t.warehouses.PAR,
    items: [{ variantId: t.variants.CASQUE, quantity }],
  };
}

describe('réservations', () => {
  it('réserve (201), rejoue sans effet (200, même réservation) et planifie l’expiration', async () => {
    const t = await createTenant(pool, { 'PAR:CASQUE': 10 });
    const body = reserveBody(t, 4);

    const first = await http
      .post('/api/v1/reservations')
      .set(as(t))
      .send(body)
      .expect(201);
    const replay = await http
      .post('/api/v1/reservations')
      .set(as(t))
      .send(body)
      .expect(200);

    expect(first.body).toMatchObject({
      status: 'ACTIVE',
      reference: body.reference,
      items: [{ quantity: 4 }],
    });
    expect(replay.body.id).toBe(first.body.id);
    expect(await stockOf(pool, t.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 10,
      reserved: 4,
    });
    const queue = app.get<Queue>(getQueueToken(RESERVATION_EXPIRY_QUEUE));
    const job = await queue.getJob(`expire-${first.body.id}`);
    expect(job?.data).toEqual({
      tenantId: t.tenantId,
      reservationId: first.body.id,
    });
    expect(await job?.isDelayed()).toBe(true);
  });

  it('stock insuffisant : 409 au format Problem Details, avec le détail du manque', async () => {
    const t = await createTenant(pool, { 'PAR:CASQUE': 2 });

    const response = await http
      .post('/api/v1/reservations')
      .set(as(t))
      .send(reserveBody(t, 3))
      .expect(409);

    expect(response.headers['content-type']).toMatch(
      /application\/problem\+json/,
    );
    expect(response.body).toMatchObject({
      title: 'Stock insuffisant',
      status: 409,
      shortages: [{ variantId: t.variants.CASQUE, requested: 3, available: 2 }],
    });
  });

  it('confirmer (200), puis libérer : 409, la réservation est déjà confirmée', async () => {
    const t = await createTenant(pool, { 'PAR:CASQUE': 10 });
    const { body } = await http
      .post('/api/v1/reservations')
      .set(as(t))
      .send(reserveBody(t, 4))
      .expect(201);

    const confirmed = await http
      .post(`/api/v1/reservations/${body.id}/confirm`)
      .set(as(t))
      .expect(200);
    const release = await http
      .post(`/api/v1/reservations/${body.id}/release`)
      .set(as(t))
      .expect(409);

    expect(confirmed.body.status).toBe('CONFIRMED');
    expect(release.body.reservationStatus).toBe('CONFIRMED');
    const stock = await http.get('/api/v1/inventory').set(as(t)).expect(200);
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
    const t = await createTenant(pool, { 'PAR:CASQUE': 1 });

    const response = await http
      .post('/api/v1/inventory/receipts')
      .set(as(t))
      .send({
        warehouseId: t.warehouses.PAR,
        variantId: t.variants.CASQUE,
        quantity: 9,
      })
      .expect(201);

    expect(response.body).toMatchObject({ onHand: 10, available: 10 });
    const { rows } = await pool.query(
      "SELECT quantity FROM stock_movements WHERE stock_item_id = $1 AND type = 'RECEIPT'",
      [t.stockItems['PAR:CASQUE']],
    );
    expect(rows).toEqual([{ quantity: 9 }]);
  });
});

describe('entrées refusées', () => {
  it.each([
    ['quantité nulle', { quantity: 0 }],
    ['quantité décimale', { quantity: 1.5 }],
    ['champ inconnu', { quantity: 1, prix: 0 }],
  ])('%s : 400', async (_, item) => {
    const t = await createTenant(pool, { 'PAR:CASQUE': 1 });
    const body = {
      reference: 'x',
      warehouseId: t.warehouses.PAR,
      items: [{ variantId: t.variants.CASQUE, ...item }],
    };

    const response = await http
      .post('/api/v1/reservations')
      .set(as(t))
      .send(body)
      .expect(400);

    expect(response.body.status).toBe(400);
  });

  it('sans entreprise : 400', async () => {
    await http.get('/api/v1/inventory').expect(400);
  });

  it('identifiant mal formé dans l’URL : 400, sans requête en base', async () => {
    const t = await createTenant(pool, { 'PAR:CASQUE': 1 });
    await http.get('/api/v1/reservations/pas-un-uuid').set(as(t)).expect(400);
  });
});

describe('isolation entre entreprises', () => {
  it('la réservation d’une autre entreprise répond 404, jamais 403', async () => {
    const a = await createTenant(pool, { 'PAR:CASQUE': 10 });
    const b = await createTenant(pool, { 'PAR:CASQUE': 10 });
    const { body } = await http
      .post('/api/v1/reservations')
      .set(as(a))
      .send(reserveBody(a, 1))
      .expect(201);

    await http.get(`/api/v1/reservations/${body.id}`).set(as(b)).expect(404);
    await http
      .post(`/api/v1/reservations/${body.id}/confirm`)
      .set(as(b))
      .expect(404);
    const stockB = await http.get('/api/v1/inventory').set(as(b)).expect(200);
    expect(
      stockB.body.map((s: { stockItemId: string }) => s.stockItemId),
    ).toEqual([b.stockItems['PAR:CASQUE']]);
  });

  it('réserver dans l’entrepôt d’une autre entreprise : 422, rien n’est réservé', async () => {
    const a = await createTenant(pool, { 'PAR:CASQUE': 10 });
    const b = await createTenant(pool, { 'PAR:CASQUE': 10 });

    await http
      .post('/api/v1/reservations')
      .set(as(b))
      .send(reserveBody(a, 1))
      .expect(422);

    expect(await stockOf(pool, a.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 10,
      reserved: 0,
    });
  });
});

describe('santé', () => {
  it('vivant et prêt', async () => {
    await http.get('/health').expect(200, { status: 'ok' });
    await http.get('/health/ready').expect(200, { status: 'ok' });
  });
});
