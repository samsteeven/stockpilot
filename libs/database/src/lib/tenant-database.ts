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

/**
 * Seule porte d'accès aux données d'une entreprise.
 *
 * Chaque appel ouvre une transaction et y pose `app.tenant_id` avec set_config(…, true) : la Row-Level Security
 * de PostgreSQL ne montre alors que les lignes de cette entreprise, et refuse d'en écrire pour une autre. Le
 * réglage est local à la transaction : il disparaît au COMMIT ou au ROLLBACK et ne peut pas fuir vers la requête
 * suivante qui réutiliserait la même connexion du pool.
 */
@Injectable()
export class TenantDatabase {
  constructor(private readonly prisma: PrismaService) {}

  async run<T>(
    tenantId: string,
    work: (tx: TenantTransaction) => Promise<T>,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (!UUID.test(tenantId)) {
      throw new InvalidTenantError();
    }
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return work(tx);
      },
      { timeout: options.timeoutMs ?? 10_000, maxWait: 5_000 },
    );
  }
}
