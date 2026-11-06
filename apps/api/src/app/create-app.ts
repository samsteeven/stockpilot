import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Metrics } from '@stockpilot/observability';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { ApiConfig } from './config';

/** Construit l'application (utilisé par main.ts et par les tests HTTP). */
export async function createApp(
  config: ApiConfig,
): Promise<{ app: INestApplication; metrics: Metrics }> {
  const metrics = new Metrics('api');
  const app = await NestFactory.create(AppModule.forRoot(config, metrics), {
    bufferLogs: true,
    // Corps brut conservé : la signature du prestataire de paiement porte sur les octets reçus, pas sur le JSON relu.
    rawBody: true,
  });
  app.useLogger(app.get(Logger));
  // Derrière un proxy (ALB, nginx) : l'adresse du client vient de X-Forwarded-For (limite de débit par IP).
  (
    app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void }
  ).set('trust proxy', 1);
  // Durée de chaque requête, par gabarit de route (/api/v1/orders/:id) : pas une série par identifiant.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const end = metrics.httpDuration.startTimer();
    res.on('finish', () => {
      const route = req.route?.path
        ? `${req.baseUrl}${String(req.route.path)}`
        : 'unmatched';
      end({ method: req.method, route, status: String(res.statusCode) });
    });
    next();
  });
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
  return { app, metrics };
}
