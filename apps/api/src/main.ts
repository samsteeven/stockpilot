import { Logger } from '@nestjs/common';
import { createApp } from './app/create-app';
import { loadApiConfig } from './app/config';

async function bootstrap() {
  const config = loadApiConfig();
  const { app, metrics } = await createApp(config);
  await app.listen(config.port);
  if (config.metricsPort) {
    const server = await metrics.listen(config.metricsPort);
    app.getHttpServer().on('close', () => server.close());
  }
  Logger.log(
    `API StockPilot sur http://localhost:${config.port}/api/v1` +
      (config.metricsPort
        ? `, métriques sur :${config.metricsPort}/metrics`
        : ''),
    'Bootstrap',
  );
}

void bootstrap();
