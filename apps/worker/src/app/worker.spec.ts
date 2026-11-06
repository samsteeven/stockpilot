/**
 * Le worker réel, sur une vraie file BullMQ : une réservation expire à son échéance, et le balayage rattrape une
 * réservation dont le job a été perdu.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaService, TenantDatabase } from '@stockpilot/database';
import { ReservationService } from '@stockpilot/inventory';
import { OrderService } from '@stockpilot/orders';
import {
  appDatabaseUrl,
  createTenant,
  ownerPool,
  redisUrl,
  stockOf,
} from '@stockpilot/testing';
import type { Pool } from 'pg';
import { WorkerModule } from './app.module';

let worker: INestApplicationContext;
let pool: Pool;
let prisma: PrismaService;

beforeAll(async () => {
  pool = ownerPool();
  prisma = new PrismaService({ url: appDatabaseUrl(), poolSize: 3 });
  worker = await NestFactory.createApplicationContext(
    WorkerModule.forRoot({
      appDatabaseUrl: appDatabaseUrl(),
      databasePoolSize: 3,
      redisUrl: redisUrl(),
      reservationTtlSeconds: 900,
      outboxPollMs: 100,
    }),
    { logger: ['error', 'warn'] },
  );
  await worker.init();
});

afterAll(async () => {
  await worker?.close();
  await prisma?.$disconnect();
  await pool?.end();
});

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

it('une réservation expire à son échéance et rend son stock', async () => {
  const t = await createTenant(pool, { 'PAR:CASQUE': 10 });
  // Le service du worker planifie l'expiration dans la vraie file : délai d'une seconde.
  const reservations = worker.get(ReservationService);
  const { reservation } = await reservations.reserve(t.tenantId, {
    reference: randomUUID(),
    warehouseId: t.warehouses.PAR,
    items: [{ variantId: t.variants.CASQUE, quantity: 4 }],
    ttlSeconds: 1,
  });

  const status = await waitFor(
    async () => (await reservations.get(t.tenantId, reservation.id)).status,
    (s) => s !== 'ACTIVE',
  );

  expect(status).toBe('EXPIRED');
  expect(await stockOf(pool, t.stockItems['PAR:CASQUE'])).toEqual({
    onHand: 10,
    reserved: 0,
  });
});

it('le balayage expire une réservation dont le job a été perdu', async () => {
  const t = await createTenant(pool, { 'PAR:CASQUE': 10 });
  // Réservation créée sans planificateur : comme si Redis avait été injoignable à ce moment-là.
  const withoutQueue = new ReservationService(
    new TenantDatabase(prisma),
    prisma,
  );
  const { reservation } = await withoutQueue.reserve(t.tenantId, {
    reference: randomUUID(),
    warehouseId: t.warehouses.PAR,
    items: [{ variantId: t.variants.CASQUE, quantity: 3 }],
    ttlSeconds: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 1_100));

  // Le balayage répétitif tourne toutes les 30 s ; on l'appelle directement comme le ferait son job.
  const expired = await worker.get(ReservationService).sweepExpired(1000);

  expect(expired).toBeGreaterThanOrEqual(1);
  expect((await withoutQueue.get(t.tenantId, reservation.id)).status).toBe(
    'EXPIRED',
  );
  expect(await stockOf(pool, t.stockItems['PAR:CASQUE'])).toEqual({
    onHand: 10,
    reserved: 0,
  });
});

it('réservation expirée : l’événement passe par l’outbox et la file, et la commande est annulée', async () => {
  const t = await createTenant(pool, { 'PAR:CASQUE': 10 });
  // Délai de paiement d'une seconde ; la réservation est planifiée dans la vraie file du worker.
  const orders = new OrderService(
    new TenantDatabase(prisma),
    worker.get(ReservationService),
    { reservationTtlSeconds: 1 },
  );
  const { order } = await orders.place(t.tenantId, randomUUID(), {
    idempotencyKey: randomUUID(),
    warehouseId: t.warehouses.PAR,
    items: [{ variantId: t.variants.CASQUE, quantity: 2 }],
  });

  const cancelled = await waitFor(
    () => orders.get(t.tenantId, order.id),
    (o) => o.status !== 'PENDING_PAYMENT',
  );

  expect(cancelled.status).toBe('CANCELLED');
  expect(cancelled.cancelReason).toBe('reservation_expired');
  expect(cancelled.history.map((h) => h.toStatus)).toEqual([
    'PENDING_PAYMENT',
    'CANCELLED',
  ]);
  expect(await stockOf(pool, t.stockItems['PAR:CASQUE'])).toEqual({
    onHand: 10,
    reserved: 0,
  });
});

it('un événement livré deux fois n’annule qu’une fois', async () => {
  const t = await createTenant(pool, { 'PAR:CASQUE': 10 });
  const orders = worker.get(OrderService);
  const { order } = await orders.place(t.tenantId, randomUUID(), {
    idempotencyKey: randomUUID(),
    warehouseId: t.warehouses.PAR,
    items: [{ variantId: t.variants.CASQUE, quantity: 1 }],
  });
  const eventId = randomUUID();
  const outcomes = await Promise.all([
    orders.onReservationExpired(eventId, t.tenantId, order.reservationId!),
    orders.onReservationExpired(eventId, t.tenantId, order.reservationId!),
  ]);
  expect(outcomes.sort()).toEqual(['cancelled', 'duplicate']);
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM order_status_history WHERE order_id = $1',
    [order.id],
  );
  expect(rows[0].n).toBe(2);
});
