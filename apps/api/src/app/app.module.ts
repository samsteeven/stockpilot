import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { DatabaseModule } from '@stockpilot/database';
import {
  InventoryModule,
  ReservationExpiryQueueModule,
} from '@stockpilot/inventory';
import { ProblemDetailsFilter } from './common/problem-details.filter';
import type { ApiConfig } from './config';
import { HealthController } from './health.controller';
import {
  InventoryController,
  ReservationsController,
} from './inventory/inventory.controller';
import { API_CONFIG } from './tokens';

@Module({})
export class AppModule {
  static forRoot(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DatabaseModule.forRoot({
          url: config.appDatabaseUrl,
          poolSize: config.databasePoolSize,
        }),
        ReservationExpiryQueueModule.forRoot(config.redisUrl),
        InventoryModule,
      ],
      controllers: [
        HealthController,
        InventoryController,
        ReservationsController,
      ],
      providers: [
        { provide: API_CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    };
  }
}
