import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { CatalogModule } from '@stockpilot/catalog';
import { DatabaseModule } from '@stockpilot/database';
import { IdentityModule } from '@stockpilot/identity';
import {
  InventoryModule,
  ReservationExpiryQueueModule,
} from '@stockpilot/inventory';
import { TenancyModule } from '@stockpilot/tenancy';
import {
  ProductsController,
  WarehousesController,
} from './catalog/catalog.controller';
import { AccessGuard } from './common/access';
import { ProblemDetailsFilter } from './common/problem-details.filter';
import type { ApiConfig } from './config';
import { HealthController } from './health.controller';
import { AuthController } from './identity/auth.controller';
import {
  InvitationsController,
  MembersController,
} from './identity/members.controller';
import {
  InventoryController,
  ReservationsController,
} from './inventory/inventory.controller';
import { API_CONFIG } from './tokens';

@Module({})
export class AppModule {
  static forRoot(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DatabaseModule.forRoot({
          url: config.appDatabaseUrl,
          poolSize: config.databasePoolSize,
        }),
        ReservationExpiryQueueModule.forRoot(config.redisUrl),
        IdentityModule.forRoot({
          jwtSecret: config.jwtSecret,
          accessTokenMinutes: config.accessTokenMinutes,
          refreshTokenDays: config.refreshTokenDays,
        }),
        // Limite par adresse IP, appliquée aux seules routes qui la déclarent (inscription, connexion).
        ThrottlerModule.forRoot([
          { ttl: 60_000, limit: config.authRateLimitPerMinute },
        ]),
        TenancyModule,
        CatalogModule,
        InventoryModule,
      ],
      controllers: [
        HealthController,
        AuthController,
        MembersController,
        InvitationsController,
        ProductsController,
        WarehousesController,
        InventoryController,
        ReservationsController,
      ],
      providers: [
        { provide: API_CONFIG, useValue: config },
        { provide: APP_GUARD, useClass: AccessGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    };
  }
}
