/**
 * Le moteur de stock contre un vrai PostgreSQL, avec le rôle applicatif soumis à la Row-Level Security.
 * Les courses sont rejouées plusieurs fois : une seule exécution chanceuse ne prouverait rien.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PrismaService, TenantDatabase } from '@stockpilot/database';
import {
  appDatabaseUrl,
  createTenant,
  expireNow,
  ownerPool,
  stockOf,
} from '@stockpilot/testing';
import {
  InsufficientStockError,
  ReservationExpiredError,
  ReservationNotActiveError,
  ReservationNotFoundError,
  UnknownStockItemError,
} from './errors';
import type { ReservationExpiryScheduler } from './expiry-scheduler';
import { ReservationService } from './reservation.service';

let pool: Pool;
let prisma: PrismaService;
let tenants: TenantDatabase;
let scheduled: { tenantId: string; reservationId: string; expiresAt: Date }[];
let service: ReservationService;

const recordingScheduler: ReservationExpiryScheduler = {
  async schedule(tenantId, reservationId, expiresAt) {
    scheduled.push({ tenantId, reservationId, expiresAt });
  },
};

beforeAll(() => {
  pool = ownerPool();
  // Pool plus large que le nombre de requêtes simultanées des tests de concurrence.
  prisma = new PrismaService({ url: appDatabaseUrl(), poolSize: 25 });
  tenants = new TenantDatabase(prisma);
});

beforeEach(() => {
  scheduled = [];
  service = new ReservationService(tenants, prisma, recordingScheduler);
});

afterAll(async () => {
  await prisma.$disconnect();
  await pool.end();
});

const reserve = (
  tenantId: string,
  warehouseId: string,
  items: { variantId: string; quantity: number }[],
  reference: string = randomUUID(),
) =>
  service.reserve(tenantId, { reference, warehouseId, items, ttlSeconds: 900 });

describe('réserver', () => {
  it('réserve le disponible et planifie l’expiration', async () => {
    const t = await createTenant(pool, { 'PAR:CASQUE': 10 });

    const { reservation, changed } = await reserve(
      t.tenantId,
      t.warehouses.PAR,
      [{ variantId: t.variants.CASQUE, quantity: 4 }],
    );

    expect(changed).toBe(true);
    expect(reservation.status).toBe('ACTIVE');
    expect(await stockOf(pool, t.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 10,
      reserved: 4,
    });
    expect(scheduled).toEqual([
      {
        tenantId: t.tenantId,
        reservationId: reservation.id,
        expiresAt: reservation.expiresAt,
      },
    ]);
  });

  it('refuse tout si une seule ligne manque, sans rien garder des autres', async () => {
    const t = await createTenant(pool, { 'PAR:CASQUE': 10, 'PAR:CABLE': 1 });

    const attempt = reserve(t.tenantId, t.warehouses.PAR, [
      { variantId: t.variants.CASQUE, quantity: 3 },
      { variantId: t.variants.CABLE, quantity: 2 },
    ]);

    await expect(attempt).rejects.toBeInstanceOf(InsufficientStockError);
    await expect(attempt).rejects.toMatchObject({
      shortages: [{ variantId: t.variants.CABLE, requested: 2, available: 1 }],
    });
    expect(await stockOf(pool, t.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 10,
      reserved: 0,
    });
    expect(scheduled).toEqual([]);
  });

  it('additionne deux lignes du même article', async () => {
    const t = await createTenant(pool, { 'PAR:CASQUE': 5 });

    await reserve(t.tenantId, t.warehouses.PAR, [
      { variantId: t.variants.CASQUE, quantity: 2 },
      { variantId: t.variants.CASQUE, quantity: 2 },
    ]);

    expect(await stockOf(pool, t.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 5,
      reserved: 4,
    });
  });

  it('refuse un article absent de l’entrepôt', async () => {
    const t = await createTenant(pool, { 'PAR:CASQUE': 5, 'LYO:CABLE': 5 });

    await expect(
      reserve(t.tenantId, t.warehouses.PAR, [
        { variantId: t.variants.CABLE, quantity: 1 },
      ]),
    ).rejects.toBeInstanceOf(UnknownStockItemError);
  });

  it('une réservation valide reste valide si sa planification échoue (le balayage la rattrapera)', async () => {
    const t = await createTenant(pool, { 'PAR:CASQUE': 5 });
    service = new ReservationService(tenants, prisma, {
      schedule: async () => {
        throw new Error('Redis injoignable');
      },
    });

    const { changed } = await reserve(t.tenantId, t.warehouses.PAR, [
      { variantId: t.variants.CASQUE, quantity: 1 },
    ]);

    expect(changed).toBe(true);
    expect(await stockOf(pool, t.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 5,
      reserved: 1,
    });
  });
});

describe('concurrence', () => {
  it.each(Array.from({ length: 10 }, (_, round) => round + 1))(
    'vingt commandes simultanées pour les cinq dernières unités : exactement cinq réussissent (tour %i)',
    async () => {
      const t = await createTenant(pool, { 'PAR:CASQUE': 5 });

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          reserve(t.tenantId, t.warehouses.PAR, [
            { variantId: t.variants.CASQUE, quantity: 1 },
          ]),
        ),
      );

      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult[];
      expect(won).toHaveLength(5);
      expect(
        lost.every((r) => r.reason instanceof InsufficientStockError),
      ).toBe(true);
      expect(await stockOf(pool, t.stockItems['PAR:CASQUE'])).toEqual({
        onHand: 5,
        reserved: 5,
      });
    },
  );

  it('deux commandes de 4 pour 5 unités : une seule passe', async () => {
    for (let round = 0; round < 10; round++) {
      const t = await createTenant(pool, { 'PAR:CASQUE': 5 });
      const results = await Promise.allSettled([
        reserve(t.tenantId, t.warehouses.PAR, [
          { variantId: t.variants.CASQUE, quantity: 4 },
        ]),
        reserve(t.tenantId, t.warehouses.PAR, [
          { variantId: t.variants.CASQUE, quantity: 4 },
        ]),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await stockOf(pool, t.stockItems['PAR:CASQUE'])).toEqual({
        onHand: 5,
        reserved: 4,
      });
    }
  });

  it('des commandes A+B et B+A simultanées ne s’interbloquent pas', async () => {
    const t = await createTenant(pool, { 'PAR:CASQUE': 100, 'PAR:CABLE': 100 });
    const ab = [
      { variantId: t.variants.CASQUE, quantity: 1 },
      { variantId: t.variants.CABLE, quantity: 1 },
    ];
    const ba = [...ab].reverse();

    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) =>
        reserve(t.tenantId, t.warehouses.PAR, i % 2 ? ab : ba),
      ),
    );

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await stockOf(pool, t.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 100,
      reserved: 30,
    });
    expect(await stockOf(pool, t.stockItems['PAR:CABLE'])).toEqual({
      onHand: 100,
      reserved: 30,
    });
  });

  it('la même référence envoyée dix fois en même temps ne réserve qu’une fois', async () => {
    const t = await createTenant(pool, { 'PAR:CASQUE': 50 });
    const reference = `commande-${randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        reserve(
          t.tenantId,
          t.warehouses.PAR,
          [{ variantId: t.variants.CASQUE, quantity: 3 }],
          reference,
        ),
      ),
    );

    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.reservation.id)).size).toBe(1);
    expect(await stockOf(pool, t.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 50,
      reserved: 3,
    });
    expect(scheduled).toHaveLength(1);
  });
});

describe('confirmer, libérer, expirer', () => {
  it('confirmer sort le stock une seule fois et trace la vente', async () => {
    const t = await createTenant(pool, { 'PAR:CASQUE': 10 });
    const { reservation } = await reserve(t.tenantId, t.warehouses.PAR, [
      { variantId: t.variants.CASQUE, quantity: 4 },
    ]);

    const first = await service.confirm(t.tenantId, reservation.id);
    const second = await service.confirm(t.tenantId, reservation.id);

    expect([first.changed, second.changed]).toEqual([true, false]);
    expect(await stockOf(pool, t.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 6,
      reserved: 0,
    });
    const { rows } = await pool.query(
      'SELECT type, quantity FROM stock_movements WHERE reference_id = $1',
      [reservation.id],
    );
    expect(rows).toEqual([{ type: 'SALE', quantity: -4 }]);
  });

  it('libérer rend le stock une seule fois ; une réservation libérée ne se confirme plus', async () => {
    const t = await createTenant(pool, { 'PAR:CASQUE': 10 });
    const { reservation } = await reserve(t.tenantId, t.warehouses.PAR, [
      { variantId: t.variants.CASQUE, quantity: 4 },
    ]);

    expect((await service.release(t.tenantId, reservation.id)).changed).toBe(
      true,
    );
    expect((await service.release(t.tenantId, reservation.id)).changed).toBe(
      false,
    );
    await expect(
      service.confirm(t.tenantId, reservation.id),
    ).rejects.toBeInstanceOf(ReservationNotActiveError);
    expect(await stockOf(pool, t.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 10,
      reserved: 0,
    });
  });

  it('une réservation confirmée ne se libère pas', async () => {
    const t = await createTenant(pool, { 'PAR:CASQUE': 10 });
    const { reservation } = await reserve(t.tenantId, t.warehouses.PAR, [
      { variantId: t.variants.CASQUE, quantity: 4 },
    ]);
    await service.confirm(t.tenantId, reservation.id);

    await expect(
      service.release(t.tenantId, reservation.id),
    ).rejects.toBeInstanceOf(ReservationNotActiveError);
    expect(await stockOf(pool, t.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 6,
      reserved: 0,
    });
  });

  it('confirmation et libération simultanées : un seul gagnant, le stock reste juste', async () => {
    for (let round = 0; round < 20; round++) {
      const t = await createTenant(pool, { 'PAR:CASQUE': 10 });
      const { reservation } = await reserve(t.tenantId, t.warehouses.PAR, [
        { variantId: t.variants.CASQUE, quantity: 4 },
      ]);

      const [confirm, release] = await Promise.allSettled([
        service.confirm(t.tenantId, reservation.id),
        service.release(t.tenantId, reservation.id),
      ]);

      const confirmed = confirm.status === 'fulfilled' && confirm.value.changed;
      const released = release.status === 'fulfilled' && release.value.changed;
      expect(confirmed !== released).toBe(true); // exactement un des deux
      expect(await stockOf(pool, t.stockItems['PAR:CASQUE'])).toEqual(
        confirmed ? { onHand: 6, reserved: 0 } : { onHand: 10, reserved: 0 },
      );
    }
  });

  it('un job d’expiration arrivé trop tôt ne fait rien ; arrivé deux fois, il ne rend le stock qu’une fois', async () => {
    const t = await createTenant(pool, { 'PAR:CASQUE': 10 });
    const { reservation } = await reserve(t.tenantId, t.warehouses.PAR, [
      { variantId: t.variants.CASQUE, quantity: 4 },
    ]);

    expect((await service.expire(t.tenantId, reservation.id)).changed).toBe(
      false,
    ); // pas encore échue
    await expireNow(pool, reservation.id);
    const [a, b] = await Promise.all([
      service.expire(t.tenantId, reservation.id),
      service.expire(t.tenantId, reservation.id),
    ]);

    expect([a.changed, b.changed].filter(Boolean)).toHaveLength(1);
    expect(await stockOf(pool, t.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 10,
      reserved: 0,
    });
    await expect(
      service.confirm(t.tenantId, reservation.id),
    ).rejects.toBeInstanceOf(ReservationNotActiveError);
  });

  it('une réservation échue mais pas encore expirée ne se confirme plus', async () => {
    const t = await createTenant(pool, { 'PAR:CASQUE': 10 });
    const { reservation } = await reserve(t.tenantId, t.warehouses.PAR, [
      { variantId: t.variants.CASQUE, quantity: 4 },
    ]);
    await expireNow(pool, reservation.id);

    await expect(
      service.confirm(t.tenantId, reservation.id),
    ).rejects.toBeInstanceOf(ReservationExpiredError);
  });

  it('le balayage expire les réservations échues de toutes les entreprises', async () => {
    const a = await createTenant(pool, { 'PAR:CASQUE': 10 });
    const b = await createTenant(pool, { 'LYO:CASQUE': 10 });
    const ra = await reserve(a.tenantId, a.warehouses.PAR, [
      { variantId: a.variants.CASQUE, quantity: 2 },
    ]);
    const rb = await reserve(b.tenantId, b.warehouses.LYO, [
      { variantId: b.variants.CASQUE, quantity: 3 },
    ]);
    await expireNow(pool, ra.reservation.id);
    await expireNow(pool, rb.reservation.id);

    const expired = await service.sweepExpired(1000);

    expect(expired).toBeGreaterThanOrEqual(2);
    expect((await service.get(a.tenantId, ra.reservation.id)).status).toBe(
      'EXPIRED',
    );
    expect((await service.get(b.tenantId, rb.reservation.id)).status).toBe(
      'EXPIRED',
    );
    expect(await stockOf(pool, a.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 10,
      reserved: 0,
    });
    expect(await stockOf(pool, b.stockItems['LYO:CASQUE'])).toEqual({
      onHand: 10,
      reserved: 0,
    });
  });
});

describe('isolation entre entreprises (Row-Level Security)', () => {
  it('une entreprise ne voit ni ne touche les réservations et le stock d’une autre', async () => {
    const a = await createTenant(pool, { 'PAR:CASQUE': 10 });
    const b = await createTenant(pool, { 'PAR:CASQUE': 10 });
    const { reservation } = await reserve(a.tenantId, a.warehouses.PAR, [
      { variantId: a.variants.CASQUE, quantity: 2 },
    ]);

    await expect(
      service.get(b.tenantId, reservation.id),
    ).rejects.toBeInstanceOf(ReservationNotFoundError);
    await expect(
      service.confirm(b.tenantId, reservation.id),
    ).rejects.toBeInstanceOf(ReservationNotFoundError);
    await expect(
      service.release(b.tenantId, reservation.id),
    ).rejects.toBeInstanceOf(ReservationNotFoundError);
    // L'entrepôt et l'article de A, utilisés depuis B : invisibles, donc inconnus.
    await expect(
      reserve(b.tenantId, a.warehouses.PAR, [
        { variantId: a.variants.CASQUE, quantity: 1 },
      ]),
    ).rejects.toBeInstanceOf(UnknownStockItemError);
    expect(await stockOf(pool, a.stockItems['PAR:CASQUE'])).toEqual({
      onHand: 10,
      reserved: 2,
    });
  });

  it('même une requête sans filtre ne voit que l’entreprise du contexte', async () => {
    const a = await createTenant(pool, { 'PAR:CASQUE': 1, 'PAR:CABLE': 1 });
    await createTenant(pool, { 'PAR:CASQUE': 1 });

    const seen = await tenants.run(
      a.tenantId,
      (tx) =>
        tx.$queryRaw<
          { tenant_id: string }[]
        >`SELECT DISTINCT tenant_id FROM stock_items`,
    );

    expect(seen).toEqual([{ tenant_id: a.tenantId }]);
  });

  it('écrire une ligne pour une autre entreprise est refusé par la base', async () => {
    const a = await createTenant(pool, { 'PAR:CASQUE': 1 });
    const b = await createTenant(pool, { 'PAR:CASQUE': 1 });

    const attempt = tenants.run(
      b.tenantId,
      (tx) =>
        tx.$executeRaw`INSERT INTO reservations (id, tenant_id, reference, expires_at) VALUES (${randomUUID()}::uuid, ${a.tenantId}::uuid, 'intrus', now())`,
    );

    await expect(attempt).rejects.toThrow(/row-level security/);
  });

  it('sans contexte, le rôle applicatif ne voit rien, et le contexte ne survit pas à sa transaction', async () => {
    const a = await createTenant(pool, { 'PAR:CASQUE': 1 });
    await tenants.run(a.tenantId, (tx) => tx.stockItem.count());

    // Même pool, même connexion possiblement réutilisée : le contexte posé par set_config(…, true) a disparu.
    const outside = await prisma.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*) AS n FROM stock_items`;
    const setting = await prisma.$queryRaw<
      { v: string | null }[]
    >`SELECT current_setting('app.tenant_id', true) AS v`;

    expect(Number(outside[0].n)).toBe(0);
    expect(setting[0].v ?? '').toBe('');
  });

  it('un identifiant d’entreprise mal formé est refusé avant toute requête', async () => {
    await expect(
      tenants.run("' OR 1=1 --", (tx) => tx.stockItem.count()),
    ).rejects.toThrow('identifiant d’entreprise invalide');
  });
});

describe('règles tenues par la base elle-même', () => {
  it('un mouvement de stock ne se modifie pas : ni par l’application, ni par le propriétaire', async () => {
    const t = await createTenant(pool, { 'PAR:CASQUE': 10 });
    const { reservation } = await reserve(t.tenantId, t.warehouses.PAR, [
      { variantId: t.variants.CASQUE, quantity: 1 },
    ]);
    await service.confirm(t.tenantId, reservation.id);

    const byApp = tenants.run(
      t.tenantId,
      (tx) => tx.$executeRaw`UPDATE stock_movements SET quantity = -100`,
    );
    await expect(byApp).rejects.toThrow(/permission denied/);
    await expect(
      pool.query(
        'UPDATE stock_movements SET quantity = -100 WHERE reference_id = $1',
        [reservation.id],
      ),
    ).rejects.toThrow(/immuable/);
  });

  it('le stock réservé ne peut pas dépasser le stock physique, même par une requête directe', async () => {
    const t = await createTenant(pool, { 'PAR:CASQUE': 3 });

    await expect(
      pool.query('UPDATE stock_items SET quantity_reserved = 4 WHERE id = $1', [
        t.stockItems['PAR:CASQUE'],
      ]),
    ).rejects.toThrow(/stock_items_reserved_within_on_hand/);
  });

  it('une ligne ne peut pas référencer l’entrepôt d’une autre entreprise (clé composite)', async () => {
    const a = await createTenant(pool, { 'PAR:CASQUE': 1 });
    const b = await createTenant(pool, { 'PAR:CASQUE': 1 });

    await expect(
      pool.query(
        'INSERT INTO stock_items (id, tenant_id, warehouse_id, variant_id, updated_at) VALUES ($1, $2, $3, $4, now())',
        [randomUUID(), b.tenantId, a.warehouses.PAR, b.variants.CASQUE],
      ),
    ).rejects.toThrow(/stock_items_tenant_id_warehouse_id_fkey/);
  });
});
