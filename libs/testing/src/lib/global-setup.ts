/**
 * Une base PostgreSQL réelle pour les tests d'intégration, migrée comme en production.
 *
 * - STOCKPILOT_TEST_DATABASE_URL (rôle propriétaire) et STOCKPILOT_TEST_APP_DATABASE_URL (rôle applicatif) :
 *   une base déjà démarrée (docker compose), migrée ici.
 * - sinon : un conteneur jetable (Testcontainers), données en mémoire, rôles créés comme en production.
 * Redis de même : STOCKPILOT_TEST_REDIS_URL, sinon un conteneur jetable.
 *
 * Les tests créent chacun leurs propres entreprises : aucune donnée partagée, même sur une base commune.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..', '..');

declare global {
  var __STOCKPILOT_CONTAINERS__: { stop(): Promise<unknown> }[] | undefined;
}

export default async function globalSetup(): Promise<void> {
  globalThis.__STOCKPILOT_CONTAINERS__ = [];
  if (!process.env['STOCKPILOT_TEST_REDIS_URL']) {
    const { RedisContainer } = await import('@testcontainers/redis');
    const redis = await new RedisContainer('redis:8.6-alpine').start();
    globalThis.__STOCKPILOT_CONTAINERS__.push(redis);
    process.env['STOCKPILOT_TEST_REDIS_URL'] = redis.getConnectionUrl();
  }
  if (
    process.env['STOCKPILOT_TEST_DATABASE_URL'] &&
    process.env['STOCKPILOT_TEST_APP_DATABASE_URL']
  ) {
    migrate(process.env['STOCKPILOT_TEST_DATABASE_URL']);
    return;
  }
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('stockpilot')
    .withUsername('stockpilot')
    .withPassword('stockpilot')
    .withTmpFs({ '/var/lib/postgresql': 'rw' })
    .withCopyContentToContainer([
      {
        content: readFileSync(
          join(ROOT, 'infrastructure', 'docker', 'postgres-init.sql'),
          'utf-8',
        ),
        target: '/docker-entrypoint-initdb.d/01-roles.sql',
      },
    ])
    .start();
  globalThis.__STOCKPILOT_CONTAINERS__.push(container);
  const host = `${container.getHost()}:${container.getPort()}`;
  process.env['STOCKPILOT_TEST_DATABASE_URL'] =
    `postgresql://stockpilot:stockpilot@${host}/stockpilot`;
  process.env['STOCKPILOT_TEST_APP_DATABASE_URL'] =
    `postgresql://stockpilot_app:stockpilot_app@${host}/stockpilot`;
  migrate(process.env['STOCKPILOT_TEST_DATABASE_URL']);
}

function migrate(url: string): void {
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['prisma', 'migrate', 'deploy'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: url,
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
      },
      stdio: 'pipe',
      shell: process.platform === 'win32',
    },
  );
}
