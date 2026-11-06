import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export interface DatabaseOptions {
  /** Connexion du rôle applicatif : soumis à la Row-Level Security, jamais le propriétaire des tables. */
  url: string;
  /** Connexions gardées par processus. */
  poolSize?: number;
}

export const DATABASE_OPTIONS = Symbol('DATABASE_OPTIONS');

/**
 * Le client Prisma de l'application. À ne pas utiliser directement pour les données d'une entreprise :
 * passer par TenantDatabase, qui pose le contexte de l'entreprise dans la transaction.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(options: DatabaseOptions) {
    super({
      adapter: new PrismaPg({
        connectionString: options.url,
        max: options.poolSize ?? 10,
      }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Connexions à PostgreSQL fermées');
  }
}
