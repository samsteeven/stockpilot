import { DynamicModule, Module } from '@nestjs/common';
import { DatabaseModule } from '@stockpilot/database';
import {
  InventoryModule,
  ReservationExpiryQueueModule,
} from '@stockpilot/inventory';
import {
  ReservationExpiryProcessor,
  SweepScheduler,
} from './reservation-expiry.processor';

export interface WorkerConfig {
  appDatabaseUrl: string;
  databasePoolSize: number;
  redisUrl: string;
}

@Module({})
export class WorkerModule {
  static forRoot(config: WorkerConfig): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        DatabaseModule.forRoot({
          url: config.appDatabaseUrl,
          poolSize: config.databasePoolSize,
        }),
        ReservationExpiryQueueModule.forRoot(config.redisUrl),
        InventoryModule,
      ],
      providers: [ReservationExpiryProcessor, SweepScheduler],
    };
  }
}
