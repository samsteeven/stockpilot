import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { DynamicModule, Injectable, Module } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  type ExpireReservationJob,
  RESERVATION_EXPIRY_QUEUE,
  RESERVATION_EXPIRY_SCHEDULER,
  type ReservationExpiryScheduler,
} from '../expiry-scheduler.js';

/**
 * Un job différé par réservation, à son échéance. L'identifiant du job est celui de la réservation : planifier deux
 * fois la même ne crée pas deux jobs. Le worker recontrôle l'état en base avant d'agir.
 */
@Injectable()
export class BullmqExpiryScheduler implements ReservationExpiryScheduler {
  constructor(
    @InjectQueue(RESERVATION_EXPIRY_QUEUE)
    private readonly queue: Queue<ExpireReservationJob>,
  ) {}

  async schedule(
    tenantId: string,
    reservationId: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.queue.add(
      'expire',
      { tenantId, reservationId },
      {
        jobId: `expire-${reservationId}`,
        delay: Math.max(0, expiresAt.getTime() - Date.now()),
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );
  }
}

export function redisConnection(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    // BullMQ exige que les commandes bloquantes ne soient pas abandonnées après un nombre d'essais.
    maxRetriesPerRequest: null,
  };
}

/** File d'expiration et planificateur, pour l'API (qui planifie) comme pour le worker (qui exécute). */
@Module({})
export class ReservationExpiryQueueModule {
  static forRoot(redisUrl: string): DynamicModule {
    return {
      module: ReservationExpiryQueueModule,
      global: true,
      imports: [
        BullModule.forRoot({
          connection: redisConnection(redisUrl),
          prefix: 'stockpilot',
        }),
        BullModule.registerQueue({ name: RESERVATION_EXPIRY_QUEUE }),
      ],
      providers: [
        {
          provide: RESERVATION_EXPIRY_SCHEDULER,
          useClass: BullmqExpiryScheduler,
        },
      ],
      exports: [RESERVATION_EXPIRY_SCHEDULER, BullModule],
    };
  }
}
