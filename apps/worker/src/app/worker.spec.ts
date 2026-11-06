/**
 * Le worker réel, sur une vraie file BullMQ et un vrai serveur SMTP (en mémoire) : expiration des réservations,
 * balayage, outbox, annulation des commandes non payées, expédition créée à la confirmation, e-mails aux clients.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaService, TenantDatabase } from '@stockpilot/database';
import { ReservationService } from '@stockpilot/inventory';
import { METRICS, type Metrics } from '@stockpilot/observability';
import { OrderService, PaymentService, signPayload } from '@stockpilot/orders';
import { ShipmentService } from '@stockpilot/shipping';
import { SMTPServer } from 'smtp-server';
import {
  appDatabaseUrl,
  createTenant,
  ownerPool,
  redisUrl,
  stockOf,
} from '@stockpilot/testing';
import type { Pool } from 'pg';
import { WorkerModule } from './app.module';
import { MetricsRefresher } from './metrics-refresher';

let worker: INestApplicationContext;
let pool: Pool;
let prisma: PrismaService;
let smtp: SMTPServer;

interface ReceivedMail {
  to: string[];
  raw: string;
}
const inbox: ReceivedMail[] = [];
/** Nombre de messages que le serveur SMTP refusera encore (panne simulée). */
let refuseNext = 0;

beforeAll(async () => {
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onData(stream, session, callback) {
      let raw = '';
      stream.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      stream.on('end', () => {
        if (refuseNext > 0) {
          refuseNext--;
          const error = new Error('boîte indisponible') as Error & {
            responseCode: number;
          };
          error.responseCode = 451;
          return callback(error);
        }
        inbox.push({
          to: session.envelope.rcptTo.map((r) => r.address),
          // Quoted-printable : on recolle les lignes coupées pour chercher dans le texte.
          raw: raw.replace(/=\r?\n/g, ''),
        });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  const smtpPort = (smtp.server.address() as { port: number }).port;
  pool = ownerPool();
  prisma = new PrismaService({ url: appDatabaseUrl(), poolSize: 3 });
  worker = await NestFactory.createApplicationContext(
    WorkerModule.forRoot({
      appDatabaseUrl: appDatabaseUrl(),
      databasePoolSize: 3,
      redisUrl: redisUrl(),
      reservationTtlSeconds: 900,
      outboxPollMs: 100,
      smtpUrl: `smtp://127.0.0.1:${smtpPort}`,
      mailFrom: 'StockPilot <no-reply@stockpilot.test>',
      logLevel: 'warn',
    }),
    { logger: ['error', 'warn'] },
  );
  await worker.init();
});

afterAll(async () => {
  await worker?.close();
  await prisma?.$disconnect();
  await pool?.end();
  await new Promise<void>((resolve) => smtp?.close(() => resolve()));
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

const SECRET = 'secret-de-test-du-prestataire-de-paiement-0123';

/** Commande d'un client, payée : la confirmation part dans l'outbox comme en production. */
async function paidOrder(email: string) {
  const t = await createTenant(pool, { 'PAR:CASQUE': 10 });
  const tenants = new TenantDatabase(prisma);
  const reservations = worker.get(ReservationService);
  const orders = new OrderService(tenants, reservations, {
    reservationTtlSeconds: 900,
  });
  const { order } = await orders.place(t.tenantId, randomUUID(), {
    idempotencyKey: randomUUID(),
    warehouseId: t.warehouses.PAR,
    items: [{ variantId: t.variants.CASQUE, quantity: 1 }],
    customerEmail: email,
  });
  const payments = new PaymentService(prisma, tenants, reservations, {
    reservationTtlSeconds: 900,
    paymentWebhookSecret: SECRET,
  });
  const body = Buffer.from(
    JSON.stringify({
      id: `evt_${randomUUID()}`,
      type: 'payment.succeeded',
      data: {
        providerReference: order.payment!.providerReference,
        amount: order.totalAmount,
        currency: order.currency,
      },
    }),
  );
  const { outcome } = await payments.handleNotification(
    body,
    signPayload(SECRET, body),
  );
  expect(outcome).toBe('confirmed');
  return { tenantId: t.tenantId, order, orders };
}

const mailsTo = (email: string) => inbox.filter((m) => m.to.includes(email));

it('commande payée : le worker crée l’expédition et écrit au client ; expédiée : second e-mail avec le suivi', async () => {
  const email = `client-${randomUUID().slice(0, 8)}@example.com`;
  const { tenantId, order, orders } = await paidOrder(email);
  const ref = order.id.slice(0, 8).toUpperCase();

  const withShipment = await waitFor(
    () => orders.get(tenantId, order.id),
    (o) => !!o.shipment,
  );
  expect(withShipment.shipment?.status).toBe('READY_TO_SHIP');
  await waitFor(
    async () => mailsTo(email).length,
    (n) => n >= 1,
  );
  expect(mailsTo(email)[0].raw).toContain(ref);

  await worker
    .get(ShipmentService)
    .ship(tenantId, randomUUID(), withShipment.shipment!.id, {
      carrier: 'Colissimo',
      trackingNumber: '6A99887766',
    });
  await waitFor(
    async () => mailsTo(email).length,
    (n) => n >= 2,
  );
  expect(mailsTo(email)[1].raw).toContain('6A99887766');
  const { rows } = await pool.query(
    'SELECT template, status FROM notifications WHERE tenant_id = $1 ORDER BY created_at',
    [tenantId],
  );
  expect(rows).toEqual([
    { template: 'order-confirmed', status: 'SENT' },
    { template: 'shipment-shipped', status: 'SENT' },
  ]);
});

it('serveur SMTP en panne : l’échec est noté, le job est rejoué, le client reçoit un seul message', async () => {
  const email = `client-${randomUUID().slice(0, 8)}@example.com`;
  refuseNext = 1;
  const { tenantId } = await paidOrder(email);

  const sent = await waitFor(
    async () =>
      (
        await pool.query(
          "SELECT status, attempts FROM notifications WHERE tenant_id = $1 AND template = 'order-confirmed'",
          [tenantId],
        )
      ).rows[0],
    (row) => row?.status === 'SENT',
  );
  expect(sent).toEqual({ status: 'SENT', attempts: 2 });
  expect(mailsTo(email)).toHaveLength(1);
});

it('métriques : événements traités par type et issue, retard de l’outbox, jobs par file', async () => {
  const email = `client-${randomUUID().slice(0, 8)}@example.com`;
  const { tenantId, order, orders } = await paidOrder(email);
  await waitFor(
    () => orders.get(tenantId, order.id),
    (o) => !!o.shipment,
  );
  const metrics = worker.get<Metrics>(METRICS);
  // Le compteur est incrémenté à la fin du traitement (après l'envoi du message).
  const events = await waitFor(
    () =>
      metrics.registry.getSingleMetricAsString(
        'stockpilot_domain_events_total',
      ),
    (text) => /type="order.confirmed",outcome="sent"/.test(text),
  );
  expect(events).toMatch(/type="order.confirmed",outcome="created"/);
  expect(events).toMatch(/type="order.confirmed",outcome="sent"/);

  await worker.get(MetricsRefresher).refresh();
  const backlog = await metrics.registry.getSingleMetricAsString(
    'stockpilot_outbox_oldest_age_seconds',
  );
  expect(backlog).toMatch(
    /stockpilot_outbox_oldest_age_seconds\{service="worker"\} [0-9.e+-]+/,
  );
  expect(
    await metrics.registry.getSingleMetricAsString('stockpilot_queue_jobs'),
  ).toContain('queue="domain-events"');
});
