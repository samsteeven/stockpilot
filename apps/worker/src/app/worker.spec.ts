/**
 * Le worker réel, sur une vraie file BullMQ : une réservation expire à son échéance, et le balayage rattrape une
 * réservation dont le job a été perdu.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaService, TenantDatabase } from '@stockpilot/database';
import { ReservationService } from '@stockpilot/inventory';
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
