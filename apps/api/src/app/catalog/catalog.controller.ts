import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CatalogService } from '@stockpilot/catalog';
import { CurrentTenant, RequirePermission } from '../common/access';
import {
  CreateProductDto,
  CreateWarehouseDto,
  ProductQueryDto,
  VariantDto,
} from './dto';

@Controller('products')
export class ProductsController {
  constructor(private readonly catalog: CatalogService) {}

  @RequirePermission('stock:read')
  @Get()
  list(@CurrentTenant() tenantId: string, @Query() query: ProductQueryDto) {
    return this.catalog.listProducts(tenantId, {
      limit: query.limit ?? 50,
      cursor: query.cursor,
      search: query.search,
    });
  }

  @RequirePermission('catalog:write')
  @Post()
  create(@CurrentTenant() tenantId: string, @Body() body: CreateProductDto) {
    return this.catalog.createProduct(tenantId, body);
  }

  @RequirePermission('catalog:write')
  @Post(':id/variants')
  addVariant(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) productId: string,
    @Body() body: VariantDto,
  ) {
    return this.catalog.addVariant(tenantId, productId, body);
  }
}

@Controller('warehouses')
export class WarehousesController {
  constructor(private readonly catalog: CatalogService) {}

  @RequirePermission('stock:read')
  @Get()
  list(@CurrentTenant() tenantId: string) {
    return this.catalog.listWarehouses(tenantId);
  }

  @RequirePermission('warehouses:write')
  @Post()
  create(@CurrentTenant() tenantId: string, @Body() body: CreateWarehouseDto) {
    return this.catalog.createWarehouse(tenantId, body);
  }
}
