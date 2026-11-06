/** Comptes et sessions, contre PostgreSQL réel : inscription, connexion, renouvellement à rotation, rejeu, déconnexion. */
import type { INestApplication } from '@nestjs/common';
import { ownerPool } from '@stockpilot/testing';
import type { Pool } from 'pg';
import {
  bearer,
  type Http,
  logIn,
  newEmail,
  PASSWORD,
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

const refresh = (cookie: string) =>
  http
    .post('/api/v1/auth/refresh')
    .set('Cookie', cookie)
    .set('X-Requested-With', 'StockPilot');

describe('inscription et connexion', () => {
  it('l’inscription crée le compte, son entreprise et en fait le propriétaire', async () => {
    const account = await signUp(http, newEmail(), 'Brûlerie Saint-Éloi');

    const me = await http
      .get('/api/v1/auth/me')
      .set(bearer(account.accessToken))
      .expect(200);

    expect(me.body).toMatchObject({
      email: account.email,
      tenants: [
        {
          tenantId: account.tenantId,
          name: 'Brûlerie Saint-Éloi',
          role: 'OWNER',
        },
      ],
    });
    expect(me.body.tenants[0].slug).toMatch(/^brulerie-saint-eloi-/);
    const { rows } = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [account.userId],
    );
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });

  it('le cookie de session est HttpOnly, SameSite=Strict et limité aux routes d’authentification', async () => {
    const response = await http
      .post('/api/v1/auth/register')
      .send({ email: newEmail(), password: PASSWORD, companyName: 'Atelier' })
      .expect(201);

    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(response.body.refreshToken).toBeUndefined();
  });

  it('une adresse déjà utilisée (casse comprise) : 409', async () => {
    const email = newEmail();
    await signUp(http, email);

    await http
      .post('/api/v1/auth/register')
      .send({
        email: email.toUpperCase(),
        password: PASSWORD,
        companyName: 'Autre',
      })
      .expect(409);
  });

  it('mot de passe trop court : 400', async () => {
    await http
      .post('/api/v1/auth/register')
      .send({ email: newEmail(), password: 'court', companyName: 'Atelier' })
      .expect(400);
  });

  it('mauvais mot de passe et e-mail inconnu : même réponse', async () => {
    const account = await signUp(http);

    const wrong = await http
      .post('/api/v1/auth/login')
      .send({ email: account.email, password: 'pas-le-bon-mot' })
      .expect(401);
    const unknown = await http
      .post('/api/v1/auth/login')
      .send({ email: newEmail(), password: 'pas-le-bon-mot' })
      .expect(401);

    expect(wrong.body.title).toBe(unknown.body.title);
    expect(wrong.body.detail).toBe(unknown.body.detail);
  });

  it('sans jeton, jeton falsifié ou expiré : 401', async () => {
    const account = await signUp(http);
    const [header, payload] = account.accessToken.split('.');

    await http.get('/api/v1/auth/me').expect(401);
    await http
      .get('/api/v1/auth/me')
      .set(bearer(`${header}.${payload}.signature-falsifiee`))
      .expect(401);
    const { app: expiring, http: shortLived } = await startApi({
      accessTokenMinutes: 1,
    });
    try {
      const session = await logIn(shortLived, account.email);
      jest.useFakeTimers({
        now: Date.now() + 2 * 60_000,
        doNotFake: ['nextTick', 'setImmediate'],
      });
      await shortLived
        .get('/api/v1/auth/me')
        .set(bearer(session.accessToken))
        .expect(401);
    } finally {
      jest.useRealTimers();
      await expiring.close();
    }
  });
});

describe('renouvellement', () => {
  it('chaque renouvellement remplace le jeton ; l’ancien ne vaut plus rien', async () => {
    const account = await signUp(http);

    const first = await refresh(account.cookie).expect(200);
    const newCookie = String(first.headers['set-cookie']).split(';')[0];

    expect(newCookie).not.toBe(account.cookie);
    await http
      .get('/api/v1/auth/me')
      .set(bearer(first.body.accessToken))
      .expect(200);
    await refresh(newCookie).expect(200);
  });

  it('un jeton rejoué révoque toute la session, y compris le jeton légitime suivant', async () => {
    const account = await signUp(http);
    const legit = await refresh(account.cookie).expect(200);
    const legitCookie = String(legit.headers['set-cookie']).split(';')[0];

    await refresh(account.cookie).expect(401); // l'ancien jeton, volé et rejoué
    await refresh(legitCookie).expect(401); // la session entière est tombée

    const { rows } = await pool.query(
      'SELECT count(*)::int AS active FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL',
      [account.userId],
    );
    expect(rows[0].active).toBe(0);
  });

  it('sans l’en-tête X-Requested-With : 403 (un formulaire d’un autre site ne peut pas le poser)', async () => {
    const account = await signUp(http);

    await http
      .post('/api/v1/auth/refresh')
      .set('Cookie', account.cookie)
      .expect(403);
  });

  it('la déconnexion révoque la session', async () => {
    const account = await signUp(http);

    await http
      .post('/api/v1/auth/logout')
      .set('Cookie', account.cookie)
      .set('X-Requested-With', 'StockPilot')
      .expect(204);

    await refresh(account.cookie).expect(401);
  });

  it('une autre connexion ouvre une session indépendante', async () => {
    const account = await signUp(http);
    const other = await logIn(http, account.email);

    await http
      .post('/api/v1/auth/logout')
      .set('Cookie', account.cookie)
      .set('X-Requested-With', 'StockPilot')
      .expect(204);

    await refresh(other.cookie).expect(200);
  });
});

describe('limite de débit', () => {
  it('au-delà de la limite par minute, la connexion répond 429', async () => {
    const { app: limited, http: limitedHttp } = await startApi({
      authRateLimitPerMinute: 3,
    });
    try {
      const email = newEmail();
      for (let i = 0; i < 3; i++) {
        await limitedHttp
          .post('/api/v1/auth/login')
          .send({ email, password: 'x-mauvais-mot' })
          .expect(401);
      }
      await limitedHttp
        .post('/api/v1/auth/login')
        .send({ email, password: 'x-mauvais-mot' })
        .expect(429);
    } finally {
      await limited.close();
    }
  });
});
