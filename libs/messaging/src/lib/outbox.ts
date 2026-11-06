import { randomUUID } from 'node:crypto';
import type { TenantTransaction } from '@stockpilot/database';

/** Événement du domaine, tel qu'il est écrit dans l'outbox puis publié dans la file `domain-events`. */
export interface DomainEvent<T = Record<string, unknown>> {
  id: string;
  tenantId: string | null;
  type: string;
  payload: T;
  correlationId: string | null;
  occurredAt: string;
}

export const DOMAIN_EVENTS_QUEUE = 'domain-events';

export interface NewEvent {
  tenantId: string | null;
  type: string;
  payload: Record<string, unknown>;
  correlationId?: string;
}

/**
 * Écrit un événement dans l'outbox, dans la transaction du changement qu'il annonce : si la transaction est
 * annulée, l'événement disparaît avec elle ; si elle est validée, il sera publié, même si Redis est indisponible
 * à cet instant. L'application n'a que le droit d'insérer : elle ne relit pas l'outbox.
 */
export async function recordEvent(
  tx: TenantTransaction,
  event: NewEvent,
): Promise<string> {
  const id = randomUUID();
  await tx.$executeRaw`
    INSERT INTO outbox_events (id, tenant_id, type, payload, correlation_id)
    VALUES (${id}::uuid, ${event.tenantId}::uuid, ${event.type}, ${JSON.stringify(event.payload)}::jsonb,
            ${event.correlationId ?? null})`;
  return id;
}

/**
 * Marque un message comme traité par un consommateur, dans la transaction de son effet. Rend faux s'il l'était
 * déjà : la livraison « au moins une fois » de la file devient un effet « une seule fois ».
 */
export async function markProcessed(
  tx: TenantTransaction,
  consumer: string,
  messageId: string,
): Promise<boolean> {
  const inserted = await tx.$executeRaw`
    INSERT INTO processed_messages (consumer, message_id) VALUES (${consumer}, ${messageId})
    ON CONFLICT DO NOTHING`;
  return inserted === 1;
}
