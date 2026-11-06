import { Logger } from '@nestjs/common';
import { Metrics } from '@stockpilot/observability';
import { Logger as PinoLogger } from 'nestjs-pino';
import { NestFactory } from '@nestjs/core';
import { WorkerModule, type WorkerConfig } from './app/app.module';

function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`Variable d'environnement ${name} manquante`);
    return value;
  };
  return {
    appDatabaseUrl: required('APP_DATABASE_URL'),
    databasePoolSize: Number(env['DATABASE_POOL_SIZE'] ?? 5),
    redisUrl: required('REDIS_URL'),
    reservationTtlSeconds: Number(env['RESERVATION_TTL_SECONDS'] ?? 900),
    outboxPollMs: Number(env['OUTBOX_POLL_MS'] ?? 500),
    smtpUrl: env['SMTP_URL'] || undefined,
    mailFrom: env['MAIL_FROM'] ?? 'StockPilot <no-reply@stockpilot.local>',
    logLevel: env['LOG_LEVEL'] || 'info',
  };
}

/** Pas de serveur HTTP : un contexte d'application qui consomme les files BullMQ. */
async function bootstrap() {
  const metrics = new Metrics('worker');
  const app = await NestFactory.createApplicationContext(
    WorkerModule.forRoot(loadWorkerConfig(), metrics),
    { bufferLogs: true },
  );
  app.useLogger(app.get(PinoLogger));
  app.enableShutdownHooks();
  // Pas de HTTP métier dans le worker : un port de métriques seulement, lu par Prometheus.
  const port = Number(process.env['METRICS_PORT'] ?? 9465);
  const server = await metrics.listen(port);
  process.once('SIGTERM', () => server.close());
  Logger.log('Worker StockPilot à l’écoute des files', 'Bootstrap');
}

void bootstrap();
