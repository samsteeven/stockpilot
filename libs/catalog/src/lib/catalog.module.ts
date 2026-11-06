import { Module } from '@nestjs/common';
import { CatalogService } from './catalog.service.js';

@Module({
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
