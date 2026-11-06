import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { DynamicModule, Injectable, Module } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  OutboxDispatcher,
  EVENT_PUBLISHER,
  type EventPublisher,
} from './outbox-dispatcher.js';
import { DOMAIN_EVENTS_QUEUE, type DomainEvent } from './outbox.js';

/**
 * Un job par événement, d'identifiant égal à celui de l'événement : un événement publié deux fois (arrêt entre la
 * publication et son marquage) ne crée pas deux jobs tant que le premier est conservé par la file.
 */
@Injectable()
export class BullmqEventPublisher implements EventPublisher {
  constructor(
    @InjectQueue(DOMAIN_EVENTS_QUEUE)
    private readonly queue: Queue<DomainEvent>,
  ) {}

  async publish(event: DomainEvent): Promise<void> {
    await this.queue.add(event.type, event, {
      jobId: event.id,
      attempts: 8,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { age: 24 * 3600 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  }
}

/**
 * File des événements du domaine et publicateur de l'outbox. Suppose BullModule.forRoot déjà configuré (connexion
 * Redis partagée avec la file d'expiration).
 */
@Module({})
export class DomainEventsModule {
  static forRoot(): DynamicModule {
    return {
      module: DomainEventsModule,
      global: true,
      imports: [BullModule.registerQueue({ name: DOMAIN_EVENTS_QUEUE })],
      providers: [
        { provide: EVENT_PUBLISHER, useClass: BullmqEventPublisher },
        OutboxDispatcher,
      ],
      exports: [EVENT_PUBLISHER, OutboxDispatcher, BullModule],
    };
  }
}
