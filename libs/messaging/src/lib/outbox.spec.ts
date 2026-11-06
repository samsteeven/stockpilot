/**
 * L'outbox contre PostgreSQL réel : un événement suit le sort de sa transaction, il est publié une fois, un échec
 * de publication le laisse en attente, deux publicateurs simultanés ne publient pas deux fois la même ligne, et
 * l'application ne peut ni le relire ni l'écrire pour une autre entreprise.
 */
import { randomUUID } from 'node:crypto';
import { PrismaService, TenantDatabase } from '@stockpilot/database';
import { appDatabaseUrl, createTenant, ownerPool } from '@stockpilot/testing';
import type { Pool } from 'pg';
import { OutboxDispatcher, type EventPublisher } from './outbox-dispatcher.js';
import { type DomainEvent, markProcessed, recordEvent } from './outbox.js';

let pool: Pool;
let prisma: PrismaService;
let tenants: TenantDatabase;
let tenantId: string;

beforeAll(async () => {
  pool = ownerPool();
  prisma = new PrismaService({ url: appDatabaseUrl(), poolSize: 6 });
  tenants = new TenantDatabase(prisma);
  tenantId = (await createTenant(pool, {})).tenantId;
});

afterAll(async () => {
  await prisma?.$disconnect();
  await pool?.end();
});

class MemoryPublisher implements EventPublisher {
  readonly published: DomainEvent[] = [];
  failFor = new Set<string>();
  async publish(event: DomainEvent): Promise<void> {
    if (this.failFor.has(event.id)) throw new Error('file indisponible');
    this.published.push(event);
  }
}

/** Publie jusqu'à épuisement (l'outbox de test peut contenir les événements d'autres suites). */
async function drain(dispatcher: OutboxDispatcher): Promise<void> {
  for (;;) {
    const { published, failed } = await dispatcher.dispatchOnce(200);
    if (published + failed === 0 || published === 0) return;
  }
}

async function record(type = 'test.event'): Promise<string> {
  return tenants.run(tenantId, (tx) =>
    recordEvent(tx, { tenantId, type, payload: { n: 1 } }),
  );
}

async function rowOf(id: string) {
  const { rows } = await pool.query(
    'SELECT published_at, attempts, last_error FROM outbox_events WHERE id = $1',
    [id],
  );
  return rows[0];
}

it('un événement d’une transaction annulée n’existe pas', async () => {
  let id = '';
  await expect(
    tenants.run(tenantId, async (tx) => {
      id = await recordEvent(tx, { tenantId, type: 'annule', payload: {} });
      throw new Error('annulation');
    }),
  ).rejects.toThrow('annulation');
  expect(await rowOf(id)).toBeUndefined();
});

it('publié une fois, avec son contenu ; un second passage ne le republie pas', async () => {
  const id = await record('commande.creee');
  const publisher = new MemoryPublisher();
  const dispatcher = new OutboxDispatcher(prisma, publisher);

  await drain(dispatcher);
  await drain(dispatcher);

  const mine = publisher.published.filter((e) => e.id === id);
  expect(mine).toEqual([
    expect.objectContaining({
      id,
      tenantId,
      type: 'commande.creee',
      payload: { n: 1 },
    }),
  ]);
  expect((await rowOf(id)).published_at).not.toBeNull();
});

it('publication refusée : l’événement reste à publier, l’échec est compté, il passe au tour suivant', async () => {
  const id = await record();
  const publisher = new MemoryPublisher();
  publisher.failFor.add(id);
  const dispatcher = new OutboxDispatcher(prisma, publisher);

  await dispatcher.dispatchOnce(500);
  const failed = await rowOf(id);
  expect(failed.published_at).toBeNull();
  expect(failed.attempts).toBe(1);
  expect(failed.last_error).toBe('file indisponible');

  publisher.failFor.clear();
  await drain(dispatcher);
  expect((await rowOf(id)).published_at).not.toBeNull();
});

it('deux publicateurs simultanés : chaque événement est publié une seule fois', async () => {
  const ids = await Promise.all(Array.from({ length: 40 }, () => record()));
  const publisher = new MemoryPublisher();
  const a = new OutboxDispatcher(prisma, publisher);
  const b = new OutboxDispatcher(prisma, publisher);

  // Petits lots, en parallèle : les deux se disputent les mêmes lignes.
  const loop = async (d: OutboxDispatcher) => {
    for (;;) {
      const { published } = await d.dispatchOnce(5);
      if (published === 0) return;
    }
  };
  await Promise.all([loop(a), loop(b)]);

  const counts = new Map<string, number>();
  for (const event of publisher.published)
    counts.set(event.id, (counts.get(event.id) ?? 0) + 1);
  for (const id of ids) expect(counts.get(id)).toBe(1);
});

it('l’application écrit dans l’outbox mais ne la lit pas, et pas pour une autre entreprise', async () => {
  await expect(
    prisma.$queryRaw`SELECT * FROM outbox_events LIMIT 1`,
  ).rejects.toThrow(/permission denied/);
  const other = (await createTenant(pool, {})).tenantId;
  await expect(
    tenants.run(tenantId, (tx) =>
      recordEvent(tx, { tenantId: other, type: 'intrus', payload: {} }),
    ),
  ).rejects.toThrow(/row-level security/);
});

it('un message n’est marqué traité qu’une fois par consommateur', async () => {
  const messageId = randomUUID();
  const first = await tenants.run(tenantId, (tx) =>
    markProcessed(tx, 'test', messageId),
  );
  const second = await tenants.run(tenantId, (tx) =>
    markProcessed(tx, 'test', messageId),
  );
  const otherConsumer = await tenants.run(tenantId, (tx) =>
    markProcessed(tx, 'autre', messageId),
  );
  expect([first, second, otherConsumer]).toEqual([true, false, true]);
});
