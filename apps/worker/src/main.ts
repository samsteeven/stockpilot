import { Logger } from '@nestjs/common';
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
  };
}

/** Pas de serveur HTTP : un contexte d'application qui consomme les files BullMQ. */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(
    WorkerModule.forRoot(loadWorkerConfig()),
  );
  app.enableShutdownHooks();
  Logger.log('Worker StockPilot à l’écoute des files', 'Bootstrap');
}

void bootstrap();
