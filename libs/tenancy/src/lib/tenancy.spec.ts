/**
 * Ce que la base garantit seule pour les adhésions, en passant outre l'API : le rôle applicatif soumis à la
 * Row-Level Security, des requêtes SQL directes.
 */
import { randomUUID } from 'node:crypto';
import { PrismaService, TenantDatabase } from '@stockpilot/database';
import { appDatabaseUrl, ownerPool } from '@stockpilot/testing';
import type { Pool } from 'pg';
import { hashToken } from './invitation.service';

let pool: Pool;
let prisma: PrismaService;
let db: TenantDatabase;

beforeAll(() => {
  pool = ownerPool();
  prisma = new PrismaService({ url: appDatabaseUrl(), poolSize: 3 });
  db = new TenantDatabase(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  await pool.end();
});

/** Une entreprise et ses membres, écrits avec le rôle propriétaire. */
async function company(roles: string[]) {
  const tenantId = randomUUID();
  await pool.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
    tenantId,
    'Société',
    `s-${tenantId}`,
  ]);
  const users: string[] = [];
  for (const role of roles) {
    const userId = randomUUID();
    await pool.query(
      "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')",
      [userId, `${userId}@test.example`],
    );
    await pool.query(
      'INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)',
      [tenantId, userId, role],
    );
    users.push(userId);
  }
  return { tenantId, users };
}

it('dans son seul contexte utilisateur, une personne voit ses adhésions mais ne peut pas changer son rôle', async () => {
  const { tenantId, users } = await company(['OWNER', 'VIEWER']);
  const viewer = users[1];

  const seen = await db.runAs(
    { userId: viewer },
    (tx) =>
      tx.$queryRaw<
        { tenant_id: string; user_id: string }[]
      >`SELECT tenant_id, user_id FROM tenant_memberships`,
  );
  const updated = await db.runAs(
    { userId: viewer },
    (tx) =>
      tx.$executeRaw`UPDATE tenant_memberships SET role = 'OWNER' WHERE user_id = ${viewer}::uuid`,
  );

  expect(seen).toEqual([{ tenant_id: tenantId, user_id: viewer }]); // pas les autres membres
  expect(updated).toBe(0); // la ligne n'est pas modifiable hors du contexte de l'entreprise
  const { rows } = await pool.query(
    'SELECT role FROM tenant_memberships WHERE user_id = $1',
    [viewer],
  );
  expect(rows[0].role).toBe('VIEWER');
});

it('une adhésion ne peut pas être créée pour une autre entreprise que celle du contexte', async () => {
  const a = await company(['OWNER']);
  const b = await company(['OWNER']);

  const attempt = db.runAs(
    { tenantId: b.tenantId, userId: b.users[0] },
    (tx) =>
      tx.$executeRaw`INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES (${a.tenantId}::uuid, ${b.users[0]}::uuid, 'OWNER')`,
  );

  await expect(attempt).rejects.toThrow(/row-level security/);
});

it('la base refuse une entreprise sans propriétaire, même par une requête directe', async () => {
  const { tenantId, users } = await company(['OWNER', 'ADMIN']);

  await expect(
    pool.query(
      "UPDATE tenant_memberships SET role = 'ADMIN' WHERE tenant_id = $1 AND user_id = $2",
      [tenantId, users[0]],
    ),
  ).rejects.toThrow(/au moins un propriétaire/);
  await expect(
    pool.query(
      'DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2',
      [tenantId, users[0]],
    ),
  ).rejects.toThrow(/au moins un propriétaire/);
});

it('la recherche d’invitation ne révèle que l’invitation dont on présente le jeton', async () => {
  const { tenantId, users } = await company(['OWNER']);
  const token = `jeton-de-test-${randomUUID()}`;
  await pool.query(
    "INSERT INTO invitations (id, tenant_id, email, role, token_hash, invited_by, expires_at) VALUES ($1, $2, 'x@test.example', 'VIEWER', $3, $4, now() + interval '1 day')",
    [randomUUID(), tenantId, hashToken(token), users[0]],
  );

  const direct = await prisma.$queryRaw<unknown[]>`SELECT * FROM invitations`;
  const byToken = await prisma.$queryRaw<
    { tenant_id: string }[]
  >`SELECT tenant_id FROM invitation_by_token_hash(${hashToken(token)})`;
  const byWrongToken = await prisma.$queryRaw<
    unknown[]
  >`SELECT * FROM invitation_by_token_hash(${hashToken('autre')})`;

  expect(direct).toEqual([]); // sans contexte d'entreprise, aucune invitation visible
  expect(byToken).toEqual([{ tenant_id: tenantId }]);
  expect(byWrongToken).toEqual([]);
});
