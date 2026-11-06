import { Logger } from '@nestjs/common';
import { createApp } from './app/create-app';
import { loadApiConfig } from './app/config';

async function bootstrap() {
  const config = loadApiConfig();
  const app = await createApp(config);
  await app.listen(config.port);
  Logger.log(
    `API StockPilot sur http://localhost:${config.port}/api/v1`,
    'Bootstrap',
  );
}

void bootstrap();
