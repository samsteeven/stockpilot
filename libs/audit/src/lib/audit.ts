import { Injectable, Module } from '@nestjs/common';
import {
  type Prisma,
  TenantDatabase,
  type TenantTransaction,
} from '@stockpilot/database';

export interface AuditEntry {
  tenantId: string;
  /** Absent quand le système agit seul (retour du prestataire de paiement, expiration). */
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string;
  details?: Record<string, unknown>;
}

/**
 * Écrit une entrée du journal dans la transaction de l'action : pas d'action sans trace, pas de trace d'une action
 * annulée. La table refuse toute modification ou suppression (déclencheur), même pour son propriétaire.
 */
export async function recordAudit(
  tx: TenantTransaction,
  entry: AuditEntry,
): Promise<void> {
  await tx.auditLog.createMany({
    data: [
      {
        tenantId: entry.tenantId,
        actorId: entry.actorId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        details: (entry.details ?? undefined) as
          Prisma.InputJsonValue | undefined,
      },
    ],
  });
}

export interface AuditQuery {
  limit?: number;
  /** Entrées antérieures à cette date (pagination vers le passé). */
  before?: Date;
  action?: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly tenants: TenantDatabase) {}

  list(tenantId: string, query: AuditQuery = {}) {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    return this.tenants.run(tenantId, (tx) =>
      tx.auditLog.findMany({
        where: {
          ...(query.before ? { createdAt: { lt: query.before } } : {}),
          ...(query.action ? { action: query.action } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
    );
  }
}

@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
