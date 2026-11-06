/**
 * Ce que l'exploitation voit de l'API : identifiant de corrélation renvoyé, durées par gabarit de route (pas une
 * série par identifiant), erreurs du domaine comptées, commandes créées ou rejouées, port de métriques séparé.
 */
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import type { Metrics } from '@stockpilot/observability';
import { createTenant, ownerPool } from '@stockpilot/testing';
import type { Pool } from 'pg';
import { type Http, signUp, startApi } from './testing';

let app: INestApplication;
let metrics: Metrics;
let pool: Pool;
let http: Http;

beforeAll(async () => {
  pool = ownerPool();
  ({ app, metrics, http } = await startApi());
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

async function series(name: string): Promise<string> {
  return (await metrics.registry.getSingleMetricAsString(name)) ?? '';
}

it('chaque réponse porte un identifiant de corrélation', async () => {
  const fresh = await http.get('/health').expect(200);
  expect(fresh.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  const kept = await http
    .get('/health')
    .set('X-Request-Id', 'front-0123456789')
    .expect(200);
  expect(kept.headers['x-request-id']).toBe('front-0123456789');
});

it('durées par gabarit de route, erreurs du domaine et commandes comptées', async () => {
  const account = await signUp(http);
  const stock = await createTenant(pool, { 'PAR:CASQUE': 1 }, account.tenantId);
  const body = {
    warehouseId: stock.warehouses.PAR,
    items: [{ variantId: stock.variants.CASQUE, quantity: 1 }],
  };
  const key = randomUUID();
  const { body: order } = await http
    .post('/api/v1/orders')
    .set(account.headers)
    .set('Idempotency-Key', key)
    .send(body)
    .expect(201);
  await http
    .post('/api/v1/orders')
    .set(account.headers)
    .set('Idempotency-Key', key)
    .send(body)
    .expect(201);
  await http
    .post('/api/v1/orders')
    .set(account.headers)
    .set('Idempotency-Key', randomUUID())
    .send(body)
    .expect(409);
  await http.get(`/api/v1/orders/${order.id}`).set(account.headers).expect(200);

  const durations = await series('stockpilot_http_request_duration_seconds');
  expect(durations).toContain('route="/api/v1/orders/:id"');
  expect(durations).toMatch(/route="\/api\/v1\/orders",status="409"/);
  expect(durations).not.toContain(order.id);
  expect(await series('stockpilot_orders_total')).toMatch(
    /outcome="created"[^\n]* 1$/m,
  );
  expect(await series('stockpilot_orders_total')).toMatch(
    /outcome="replayed"[^\n]* 1$/m,
  );
  expect(await series('stockpilot_problems_total')).toContain(
    'title="Stock insuffisant"',
  );
});

it('les métriques se lisent sur leur propre port, pas sur l’API publique', async () => {
  await http.get('/metrics').expect(404);
  await http.get('/api/v1/metrics').expect(404);
  const server = await metrics.listen(0, '127.0.0.1');
  try {
    const port = (server.address() as { port: number }).port;
    const text = await new Promise<string>((resolve, reject) => {
      httpRequest({ host: '127.0.0.1', port, path: '/metrics' }, (res) => {
        let data = '';
        res.on('data', (c: Buffer) => (data += c.toString()));
        res.on('end', () => resolve(data));
      })
        .on('error', reject)
        .end();
    });
    expect(text).toContain('stockpilot_process_cpu_seconds_total');
    expect(text).toContain('service="api"');
  } finally {
    server.close();
  }
});
