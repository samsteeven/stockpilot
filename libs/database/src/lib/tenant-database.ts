import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

export type TenantTransaction = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidTenantError extends Error {
  constructor() {
    super('identifiant d’entreprise invalide');
  }
}

export interface AccessContext {
  /** Entreprise du contexte : la Row-Level Security ne montre que ses lignes. */
  tenantId?: string;
  /** Personne du contexte : elle voit ses propres adhésions et le nom de ses entreprises. */
  userId?: string;
}

/**
 * Seule porte d'accès aux données d'une entreprise.
 *
 * Chaque appel ouvre une transaction et y pose `app.tenant_id` (et `app.user_id`) avec set_config(…, true) : la
 * Row-Level Security de PostgreSQL ne montre alors que les lignes autorisées, et refuse d'en écrire d'autres. Le
 * réglage est local à la transaction : il disparaît au COMMIT ou au ROLLBACK et ne peut pas fuir vers la requête
 * suivante qui réutiliserait la même connexion du pool.
 */
@Injectable()
export class TenantDatabase {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(
    tenantId: string,
    work: (tx: TenantTransaction) => Promise<T>,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    return this.runAs({ tenantId }, work, options);
  }

  async runAs<T>(
    context: AccessContext,
    work: (tx: TenantTransaction) => Promise<T>,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    for (const id of [context.tenantId, context.userId]) {
      if (id !== undefined && !UUID.test(id)) throw new InvalidTenantError();
    }
    return this.prisma.$transaction(
      async (tx) => {
        if (context.tenantId) {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${context.tenantId}, true)`;
        }
        if (context.userId) {
          await tx.$executeRaw`SELECT set_config('app.user_id', ${context.userId}, true)`;
        }
        return work(tx);
      },
      { timeout: options.timeoutMs ?? 10_000, maxWait: 5_000 },
    );
  }
}
