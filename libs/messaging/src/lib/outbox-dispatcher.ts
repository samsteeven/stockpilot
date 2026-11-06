import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@stockpilot/database';
import type { DomainEvent } from './outbox.js';

/** Publication d'un événement vers la file. Port : BullMQ en production, une liste en mémoire dans les tests. */
export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

interface ClaimedRow {
  id: string;
  tenant_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  occurred_at: Date;
}

export interface DispatchResult {
  published: number;
  failed: number;
}

/**
 * Publie les événements de l'outbox.
 *
 * Un lot est pris avec FOR UPDATE SKIP LOCKED (par une fonction SQL réservée) : deux workers ne publient pas les
 * mêmes lignes en même temps. Un événement est marqué publié seulement après l'accord de la file. Un arrêt entre
 * les deux le fera publier de nouveau : la livraison est « au moins une fois », et les consommateurs le savent
 * (identifiant de job = identifiant d'événement, puis table processed_messages).
 */
@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger(OutboxDispatcher.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
  ) {}

  async dispatchOnce(batch = 100): Promise<DispatchResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<ClaimedRow[]>`
          SELECT * FROM claim_outbox_events(${batch}::integer)`;
        const published: string[] = [];
        let failed = 0;
        for (const row of rows) {
          try {
            await this.publisher.publish({
              id: row.id,
              tenantId: row.tenant_id,
              type: row.type,
              payload: row.payload,
              correlationId: row.correlation_id,
              occurredAt: row.occurred_at.toISOString(),
            });
            published.push(row.id);
          } catch (error) {
            failed++;
            const message = (error as Error).message;
            this.logger.warn(`Événement ${row.id} non publié : ${message}`);
            await tx.$executeRaw`SELECT mark_outbox_failed(${row.id}::uuid, ${message})`;
          }
        }
        if (published.length > 0) {
          await tx.$executeRaw`SELECT mark_outbox_published(${published}::uuid[])`;
        }
        return { published: published.length, failed };
      },
      { timeout: 30_000, maxWait: 5_000 },
    );
  }
}
