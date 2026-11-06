import { DynamicModule, Module } from '@nestjs/common';
import { DatabaseModule } from '@stockpilot/database';
import {
  InventoryModule,
  ReservationExpiryQueueModule,
} from '@stockpilot/inventory';
import { DomainEventsModule } from '@stockpilot/messaging';
import { loggingParams, METRICS, Metrics } from '@stockpilot/observability';
import { LoggerModule } from 'nestjs-pino';
import { NotificationsModule } from '@stockpilot/notifications';
import { OrdersModule } from '@stockpilot/orders';
import { ShippingModule } from '@stockpilot/shipping';
import {
  DomainEventsProcessor,
  OUTBOX_POLL_MS,
  OutboxRelay,
} from './domain-events.processor';
import { MetricsRefresher } from './metrics-refresher';
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
  /** smtp://hôte:port des messages aux clients ; absent : messages journalisés seulement. */
  smtpUrl?: string;
  mailFrom: string;
  logLevel?: string;
}

@Module({})
export class WorkerModule {
  static forRoot(
    config: WorkerConfig,
    metrics = new Metrics('worker'),
  ): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        LoggerModule.forRoot(
          loggingParams({ service: 'worker', level: config.logLevel }),
        ),
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
        ShippingModule,
        NotificationsModule.forRoot({
          smtpUrl: config.smtpUrl,
          mailFrom: config.mailFrom,
        }),
      ],
      providers: [
        ReservationExpiryProcessor,
        SweepScheduler,
        { provide: OUTBOX_POLL_MS, useValue: config.outboxPollMs },
        OutboxRelay,
        DomainEventsProcessor,
        { provide: METRICS, useValue: metrics },
        MetricsRefresher,
      ],
    };
  }
}
