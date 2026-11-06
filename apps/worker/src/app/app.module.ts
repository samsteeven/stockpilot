import { DynamicModule, Module } from '@nestjs/common';
import { DatabaseModule } from '@stockpilot/database';
import {
  InventoryModule,
  ReservationExpiryQueueModule,
} from '@stockpilot/inventory';
import { DomainEventsModule } from '@stockpilot/messaging';
import { OrdersModule } from '@stockpilot/orders';
import {
  DomainEventsProcessor,
  OUTBOX_POLL_MS,
  OutboxRelay,
} from './domain-events.processor';
import {
  ReservationExpiryProcessor,
  SweepScheduler,
} from './reservation-expiry.processor';

export interface WorkerConfig {
  appDatabaseUrl: string;
  databasePoolSize: number;
  redisUrl: string;
  reservationTtlSeconds: number;
  /** Attente entre deux passages du relais de l'outbox quand il n'y a rien à publier. */
  outboxPollMs: number;
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
        DomainEventsModule.forRoot(),
        InventoryModule,
        OrdersModule.forRoot({
          reservationTtlSeconds: config.reservationTtlSeconds,
        }),
      ],
      providers: [
        ReservationExpiryProcessor,
        SweepScheduler,
        { provide: OUTBOX_POLL_MS, useValue: config.outboxPollMs },
        OutboxRelay,
        DomainEventsProcessor,
      ],
    };
  }
}
