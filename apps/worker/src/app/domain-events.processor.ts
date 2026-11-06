import { Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import {
  DOMAIN_EVENTS_QUEUE,
  type DomainEvent,
  OutboxDispatcher,
} from '@stockpilot/messaging';
import { OrderService } from '@stockpilot/orders';
import type { Job } from 'bullmq';

export const OUTBOX_POLL_MS = Symbol('OUTBOX_POLL_MS');

/**
 * Relais de l'outbox : publie en continu les événements écrits par l'API et le worker. Un lot plein est suivi d'un
 * autre tout de suite ; sinon, une courte attente. Plusieurs workers peuvent tourner : ils se partagent les lignes.
 */
@Injectable()
export class OutboxRelay
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxRelay.name);
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly dispatcher: OutboxDispatcher,
    @Inject(OUTBOX_POLL_MS) private readonly pollMs: number,
  ) {}

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    const batch = 100;
    let failures = 0;
    while (this.running) {
      let full = false;
      try {
        const { published, failed } = await this.dispatcher.dispatchOnce(batch);
        full = published + failed === batch;
        failures = failed > 0 ? failures + 1 : 0;
      } catch (error) {
        failures++;
        this.logger.warn(`Outbox : ${(error as Error).message}`);
      }
      if (full && failures === 0) continue;
      // Échecs répétés (Redis ou PostgreSQL indisponible) : attente croissante, plafonnée à 30 s.
      const delay = Math.min(this.pollMs * 2 ** Math.min(failures, 6), 30_000);
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        setTimeout(resolve, delay);
      });
    }
  }
}

/** Consommateur des événements du domaine. Chaque traitement est idempotent (table processed_messages). */
@Processor(DOMAIN_EVENTS_QUEUE, { concurrency: 8 })
export class DomainEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(DomainEventsProcessor.name);

  constructor(private readonly orders: OrderService) {
    super();
  }

  async process(job: Job<DomainEvent>): Promise<string> {
    const event = job.data;
    if (event.type === 'reservation.expired' && event.tenantId) {
      const outcome = await this.orders.onReservationExpired(
        event.id,
        event.tenantId,
        String(event.payload['reservationId']),
      );
      if (outcome === 'cancelled') {
        this.logger.log(
          `Commande annulée : réservation ${String(event.payload['reservationId'])} expirée`,
        );
      }
      return outcome;
    }
    // Pas encore de consommateur (notifications à l'incrément 4) : l'événement reste visible dans la file.
    return 'ignored';
  }
}
