import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import type { ApiConfig } from './config';

/** Construit l'application (utilisé par main.ts et par les tests HTTP). */
export async function createApp(config: ApiConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config), {
    logger: ['error', 'warn', 'log'],
  });
  // Derrière un proxy (ALB, nginx) : l'adresse du client vient de X-Forwarded-For (limite de débit par IP).
  (
    app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void }
  ).set('trust proxy', 1);
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // champ inconnu : rejeté plutôt qu'ignoré silencieusement
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();
  return app;
}
