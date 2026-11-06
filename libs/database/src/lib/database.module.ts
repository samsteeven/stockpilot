import { DynamicModule, Global, Module } from '@nestjs/common';
import {
  DATABASE_OPTIONS,
  DatabaseOptions,
  PrismaService,
} from './prisma.service.js';
import { TenantDatabase } from './tenant-database.js';

@Global()
@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseOptions): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: DATABASE_OPTIONS, useValue: options },
        {
          provide: PrismaService,
          useFactory: () => new PrismaService(options),
        },
        TenantDatabase,
      ],
      exports: [PrismaService, TenantDatabase],
    };
  }
}
