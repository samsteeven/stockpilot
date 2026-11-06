import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { PrismaService } from '@stockpilot/database';
import { RESERVATION_EXPIRY_QUEUE } from '@stockpilot/inventory';
import { DOMAIN_EVENTS_QUEUE } from '@stockpilot/messaging';
import { METRICS, type Metrics } from '@stockpilot/observability';
import type { Queue } from 'bullmq';

const STATES = ['waiting', 'active', 'delayed', 'failed'] as const;

/**
 * Mesures d'état, relevées toutes les 5 s : retard de l'outbox (le signe qu'un relais est arrêté ou que Redis ne
 * répond plus) et jobs par file et état (jobs en échec définitif, file qui grossit).
 */
@Injectable()
export class MetricsRefresher
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(MetricsRefresher.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(METRICS) private readonly metrics: Metrics,
    @InjectQueue(DOMAIN_EVENTS_QUEUE) private readonly events: Queue,
    @InjectQueue(RESERVATION_EXPIRY_QUEUE) private readonly expiry: Queue,
  ) {}

  onApplicationBootstrap(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 5_000);
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    try {
      const [backlog] = await this.prisma.$queryRaw<
        { pending: bigint; oldest_age_seconds: number }[]
      >`SELECT * FROM outbox_backlog()`;
      this.metrics.outboxPending.set(Number(backlog?.pending ?? 0));
      this.metrics.outboxOldestAge.set(backlog?.oldest_age_seconds ?? 0);
      for (const queue of [this.events, this.expiry]) {
        const counts = await queue.getJobCounts(...STATES);
        for (const state of STATES)
          this.metrics.queueJobs.set(
            { queue: queue.name, state },
            counts[state] ?? 0,
          );
      }
    } catch (error) {
      this.logger.warn(`Mesures non relevées : ${(error as Error).message}`);
    }
  }
}
