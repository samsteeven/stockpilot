/** Entreprises, membres, invitations et rôles : qui peut faire quoi, et dans quelle entreprise. */
import type { INestApplication } from '@nestjs/common';
import { createTenant, ownerPool } from '@stockpilot/testing';
import type { Pool } from 'pg';
import {
  type Account,
  bearer,
  type Http,
  joinAs,
  signUp,
  startApi,
} from './testing';

let app: INestApplication;
let http: Http;
let pool: Pool;

beforeAll(async () => {
  ({ app, http } = await startApi());
  pool = ownerPool();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('invitations', () => {
  it('une invitation acceptée donne le rôle prévu ; le lien ne sert qu’une fois', async () => {
    const owner = await signUp(http);
    const invited = await signUp(http);
    const { body } = await http
      .post('/api/v1/invitations')
      .set(owner.headers)
      .send({ email: invited.email.toUpperCase(), role: 'OPERATOR' })
      .expect(201);

    expect(body.token).toBeDefined();
    const accepted = await http
      .post('/api/v1/invitations/accept')
      .set(bearer(invited.accessToken))
      .send({ token: body.token })
      .expect(200);
    await http
      .post('/api/v1/invitations/accept')
      .set(bearer(invited.accessToken))
      .send({ token: body.token })
      .expect(410);

    expect(accepted.body).toEqual({
      tenantId: owner.tenantId,
      role: 'OPERATOR',
    });
    const me = await http
      .get('/api/v1/auth/me')
      .set(bearer(invited.accessToken))
      .expect(200);
    expect(me.body.tenants.map((t: { role: string }) => t.role).sort()).toEqual(
      ['OPERATOR', 'OWNER'],
    );
    const { rows } = await pool.query(
      'SELECT token_hash FROM invitations WHERE tenant_id = $1',
      [owner.tenantId],
    );
    expect(rows[0].token_hash).not.toBe(body.token); // seule l'empreinte est gardée
  });

  it('une invitation destinée à une autre adresse est refusée', async () => {
    const owner = await signUp(http);
    const intruder = await signUp(http);
    const { body } = await http
      .post('/api/v1/invitations')
      .set(owner.headers)
      .send({ email: 'quelqu-un-d-autre@atelier-nova.example', role: 'VIEWER' })
      .expect(201);

    await http
      .post('/api/v1/invitations/accept')
      .set(bearer(intruder.accessToken))
      .send({ token: body.token })
      .expect(403);
  });

  it('accepter la même invitation deux fois en même temps : une seule adhésion', async () => {
    const owner = await signUp(http);
    const invited = await signUp(http);
    const { body } = await http
      .post('/api/v1/invitations')
      .set(owner.headers)
      .send({ email: invited.email, role: 'VIEWER' })
      .expect(201);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        http
          .post('/api/v1/invitations/accept')
          .set(bearer(invited.accessToken))
          .send({ token: body.token }),
      ),
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id = $1',
      [owner.tenantId],
    );
    expect(rows[0].n).toBe(2);
  });

  it('un membre retiré ne revient pas avec son ancien lien d’invitation', async () => {
    const owner = await signUp(http);
    const invited = await signUp(http);
    const { body } = await http
      .post('/api/v1/invitations')
      .set(owner.headers)
      .send({ email: invited.email, role: 'OPERATOR' })
      .expect(201);
    await http
      .post('/api/v1/invitations/accept')
      .set(bearer(invited.accessToken))
      .send({ token: body.token })
      .expect(200);
    await http
      .delete(`/api/v1/members/${invited.userId}`)
      .set(owner.headers)
      .expect(204);

    await http
      .post('/api/v1/invitations/accept')
      .set(bearer(invited.accessToken))
      .send({ token: body.token })
      .expect(410);
    await http
      .get('/api/v1/inventory')
      .set(bearer(invited.accessToken, owner.tenantId))
      .expect(404);
  });

  it('un jeton inconnu : 410', async () => {
    const someone = await signUp(http);
    await http
      .post('/api/v1/invitations/accept')
      .set(bearer(someone.accessToken))
      .send({ token: 'jeton-qui-n-existe-pas-0123456789' })
      .expect(410);
  });
});

describe('rôles', () => {
  // Chaque rôle face à chaque action : la matrice entière, pas un échantillon.
  const actions: [
    string,
    (
      account: Account,
      fixture: { warehouse: string; variant: string },
    ) => ReturnType<Http['get']>,
  ][] = [
    ['lire le stock', (a) => http.get('/api/v1/inventory').set(a.headers)],
    ['lire le catalogue', (a) => http.get('/api/v1/products').set(a.headers)],
    ['lister les membres', (a) => http.get('/api/v1/members').set(a.headers)],
    [
      'réserver',
      (a, f) =>
        http
          .post('/api/v1/reservations')
          .set(a.headers)
          .send({
            reference: `r-${Math.random()}`,
            warehouseId: f.warehouse,
            items: [{ variantId: f.variant, quantity: 1 }],
          }),
    ],
    [
      'réceptionner',
      (a, f) =>
        http.post('/api/v1/inventory/receipts').set(a.headers).send({
          warehouseId: f.warehouse,
          variantId: f.variant,
          quantity: 1,
        }),
    ],
    [
      'créer un produit',
      (a) =>
        http
          .post('/api/v1/products')
          .set(a.headers)
          .send({
            sku: `P-${Math.floor(Math.random() * 1e9)}`,
            name: 'Produit',
            variants: [
              { sku: `V-${Math.floor(Math.random() * 1e9)}`, name: 'Unique' },
            ],
          }),
    ],
    [
      'créer un entrepôt',
      (a) =>
        http
          .post('/api/v1/warehouses')
          .set(a.headers)
          .send({
            code: `W${Math.floor(Math.random() * 1e6)}`,
            name: 'Entrepôt',
          }),
    ],
    [
      'inviter',
      (a) =>
        http
          .post('/api/v1/invitations')
          .set(a.headers)
          .send({
            email: `x-${Math.random()}@atelier-nova.example`,
            role: 'VIEWER',
          }),
    ],
  ];
  const allowed: Record<string, string[]> = {
    OWNER: [
      'lire le stock',
      'lire le catalogue',
      'lister les membres',
      'réserver',
      'réceptionner',
      'créer un produit',
      'créer un entrepôt',
      'inviter',
    ],
    ADMIN: [
      'lire le stock',
      'lire le catalogue',
      'lister les membres',
      'réserver',
      'réceptionner',
      'créer un produit',
      'créer un entrepôt',
      'inviter',
    ],
    WAREHOUSE_MANAGER: [
      'lire le stock',
      'lire le catalogue',
      'lister les membres',
      'réserver',
      'réceptionner',
    ],
    OPERATOR: [
      'lire le stock',
      'lire le catalogue',
      'lister les membres',
      'réserver',
    ],
    VIEWER: ['lire le stock', 'lire le catalogue', 'lister les membres'],
  };

  it.each(Object.keys(allowed))(
    '%s : chaque action permise passe, les autres répondent 403',
    async (role) => {
      const owner = await signUp(http);
      const stock = await createTenant(
        pool,
        { 'PAR:CASQUE': 100 },
        owner.tenantId,
      );
      const fixture = {
        warehouse: stock.warehouses.PAR,
        variant: stock.variants.CASQUE,
      };
      const account =
        role === 'OWNER' ? owner : await joinAs(http, owner, role);

      const outcome: Record<string, number> = {};
      for (const [name, act] of actions)
        outcome[name] = (await act(account, fixture)).status;

      for (const [name] of actions) {
        if (allowed[role].includes(name))
          expect([name, outcome[name] < 300]).toEqual([name, true]);
        else expect([name, outcome[name]]).toEqual([name, 403]);
      }
    },
  );

  it('un administrateur ne nomme pas de propriétaire et ne touche pas aux propriétaires', async () => {
    const owner = await signUp(http);
    const admin = await joinAs(http, owner, 'ADMIN');
    const viewer = await joinAs(http, owner, 'VIEWER');

    await http
      .patch(`/api/v1/members/${viewer.userId}`)
      .set(admin.headers)
      .send({ role: 'OWNER' })
      .expect(403);
    await http
      .patch(`/api/v1/members/${owner.userId}`)
      .set(admin.headers)
      .send({ role: 'VIEWER' })
      .expect(403);
    await http
      .delete(`/api/v1/members/${owner.userId}`)
      .set(admin.headers)
      .expect(403);
    await http
      .post('/api/v1/invitations')
      .set(admin.headers)
      .send({ email: 'p@atelier-nova.example', role: 'OWNER' })
      .expect(403);
    const promoted = await http
      .patch(`/api/v1/members/${viewer.userId}`)
      .set(admin.headers)
      .send({ role: 'OPERATOR' })
      .expect(200);
    expect(promoted.body.role).toBe('OPERATOR');
  });

  it('le dernier propriétaire ne peut ni partir ni être rétrogradé ; avec un second propriétaire, si', async () => {
    const owner = await signUp(http);

    await http
      .patch(`/api/v1/members/${owner.userId}`)
      .set(owner.headers)
      .send({ role: 'ADMIN' })
      .expect(409);
    await http
      .delete(`/api/v1/members/${owner.userId}`)
      .set(owner.headers)
      .expect(409);

    const second = await joinAs(http, owner, 'ADMIN');
    await http
      .patch(`/api/v1/members/${second.userId}`)
      .set(owner.headers)
      .send({ role: 'OWNER' })
      .expect(200);
    await http
      .delete(`/api/v1/members/${owner.userId}`)
      .set(owner.headers)
      .expect(204);
  });

  it('un membre retiré perd l’accès à la requête suivante, sans attendre l’expiration de son jeton', async () => {
    const owner = await signUp(http);
    const operator = await joinAs(http, owner, 'OPERATOR');
    await http.get('/api/v1/inventory').set(operator.headers).expect(200);

    await http
      .delete(`/api/v1/members/${operator.userId}`)
      .set(owner.headers)
      .expect(204);

    await http.get('/api/v1/inventory').set(operator.headers).expect(404);
  });

  it('un rôle abaissé s’applique à la requête suivante', async () => {
    const owner = await signUp(http);
    const admin = await joinAs(http, owner, 'ADMIN');
    await http
      .post('/api/v1/warehouses')
      .set(admin.headers)
      .send({ code: 'LYO', name: 'Lyon' })
      .expect(201);

    await http
      .patch(`/api/v1/members/${admin.userId}`)
      .set(owner.headers)
      .send({ role: 'VIEWER' })
      .expect(200);

    await http
      .post('/api/v1/warehouses')
      .set(admin.headers)
      .send({ code: 'BDX', name: 'Bordeaux' })
      .expect(403);
  });
});

describe('isolation entre entreprises', () => {
  it('le membre d’une entreprise qui désigne une autre entreprise : 404, comme si elle n’existait pas', async () => {
    const a = await signUp(http);
    const b = await signUp(http);

    const response = await http
      .get('/api/v1/inventory')
      .set(bearer(a.accessToken, b.tenantId))
      .expect(404);
    await http
      .get('/api/v1/members')
      .set(bearer(a.accessToken, b.tenantId))
      .expect(404);

    expect(response.body.title).toBe('Entreprise introuvable');
  });

  it('les membres listés sont ceux de l’entreprise, jamais d’une autre', async () => {
    const a = await signUp(http);
    const b = await signUp(http);
    await joinAs(http, b, 'VIEWER');

    const members = await http
      .get('/api/v1/members')
      .set(a.headers)
      .expect(200);

    expect(members.body.map((m: { userId: string }) => m.userId)).toEqual([
      a.userId,
    ]);
  });

  it('un utilisateur peut créer une seconde entreprise et passer de l’une à l’autre', async () => {
    const account = await signUp(http);
    const created = await http
      .post('/api/v1/auth/tenants')
      .set(bearer(account.accessToken))
      .send({ name: 'Seconde société' })
      .expect(201);

    await http
      .post('/api/v1/warehouses')
      .set(bearer(account.accessToken, created.body.tenantId))
      .send({ code: 'NTE', name: 'Nantes' })
      .expect(201);

    const first = await http
      .get('/api/v1/warehouses')
      .set(account.headers)
      .expect(200);
    const second = await http
      .get('/api/v1/warehouses')
      .set(bearer(account.accessToken, created.body.tenantId))
      .expect(200);
    expect(first.body).toEqual([]);
    expect(second.body.map((w: { code: string }) => w.code)).toEqual(['NTE']);
  });

  it('une route d’entreprise sans X-Tenant-Id : 400', async () => {
    const account = await signUp(http);
    await http
      .get('/api/v1/inventory')
      .set(bearer(account.accessToken))
      .expect(400);
  });
});
