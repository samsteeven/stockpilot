/** Aides des tests HTTP : une API démarrée sur les bases de test, et des comptes inscrits par l'API elle-même. */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { appDatabaseUrl, redisUrl } from '@stockpilot/testing';
import request from 'supertest';
import type { ApiConfig } from './config';
import { createApp } from './create-app';

export const PASSWORD = 'mot-de-passe-de-test-solide';

export async function startApi(overrides: Partial<ApiConfig> = {}) {
  const app: INestApplication = await createApp({
    port: 0,
    appDatabaseUrl: appDatabaseUrl(),
    databasePoolSize: 5,
    redisUrl: redisUrl(),
    reservationTtlSeconds: 900,
    jwtSecret: 'secret-de-test-pour-les-jetons-d-acces-0123456789',
    accessTokenMinutes: 15,
    refreshTokenDays: 14,
    cookieSecure: false,
    authRateLimitPerMinute: 10_000,
    ...overrides,
  });
  await app.init();
  return { app, http: request(app.getHttpServer()) };
}

export type Http = ReturnType<typeof request>;

export interface Account {
  email: string;
  userId: string;
  tenantId: string;
  accessToken: string;
  /** Cookie de renouvellement, tel que le navigateur le renverrait. */
  cookie: string;
  /** En-têtes d'une requête dans l'entreprise créée à l'inscription. */
  headers: Record<string, string>;
}

export function newEmail(): string {
  return `user-${randomUUID().slice(0, 10)}@atelier-nova.example`;
}

export async function signUp(
  http: Http,
  email = newEmail(),
  companyName = 'Atelier Nova',
): Promise<Account> {
  const response = await http
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, companyName })
    .expect(201);
  return toAccount(email, response.body, response.headers['set-cookie']);
}

export async function logIn(http: Http, email: string): Promise<Account> {
  const response = await http
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return toAccount(email, response.body, response.headers['set-cookie']);
}

export function bearer(token: string, tenantId?: string) {
  return {
    Authorization: `Bearer ${token}`,
    ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
  };
}

/** Un second compte, ajouté à l'entreprise d'un propriétaire avec le rôle donné (invitation acceptée). */
export async function joinAs(
  http: Http,
  owner: Account,
  role: string,
): Promise<Account> {
  const member = await signUp(http);
  const invitation = await http
    .post('/api/v1/invitations')
    .set(owner.headers)
    .send({ email: member.email, role })
    .expect(201);
  await http
    .post('/api/v1/invitations/accept')
    .set(bearer(member.accessToken))
    .send({ token: invitation.body.token })
    .expect(200);
  return {
    ...member,
    tenantId: owner.tenantId,
    headers: bearer(member.accessToken, owner.tenantId),
  };
}

function toAccount(
  email: string,
  body: { accessToken: string; userId: string; tenantId?: string },
  setCookie: string[] | string | undefined,
): Account {
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];
  const cookie = (
    cookies.find((c) => c.startsWith('stockpilot_refresh=')) ?? ''
  ).split(';')[0];
  const tenantId = body.tenantId ?? '';
  return {
    email,
    userId: body.userId,
    tenantId,
    accessToken: body.accessToken,
    cookie,
    headers: bearer(body.accessToken, tenantId || undefined),
  };
}
