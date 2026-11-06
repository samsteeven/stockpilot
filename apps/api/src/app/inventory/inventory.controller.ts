import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  type ReservationWithItems,
  ReservationService,
  StockService,
} from '@stockpilot/inventory';
import type { Response } from 'express';
import { CurrentTenant, RequirePermission } from '../common/access';
import { API_CONFIG } from '../tokens';
import type { ApiConfig } from '../config';
import { ReceiveDto, ReserveDto, StockQueryDto } from './dto';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly stock: StockService) {}

  @RequirePermission('stock:read')
  @Get()
  list(@CurrentTenant() tenantId: string, @Query() query: StockQueryDto) {
    return this.stock.list(tenantId, query.warehouseId);
  }

  @RequirePermission('stock:receive')
  @Post('receipts')
  receive(@CurrentTenant() tenantId: string, @Body() body: ReceiveDto) {
    return this.stock.receive(tenantId, body);
  }
}

@Controller('reservations')
export class ReservationsController {
  constructor(
    private readonly reservations: ReservationService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /** 201 à la création, 200 quand la même référence avait déjà réservé (requête rejouée). */
  @RequirePermission('reservations:write')
  @Post()
  async reserve(
    @CurrentTenant() tenantId: string,
    @Body() body: ReserveDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { reservation, changed } = await this.reservations.reserve(tenantId, {
      ...body,
      ttlSeconds: this.config.reservationTtlSeconds,
    });
    response.status(changed ? 201 : 200);
    return toView(reservation);
  }

  @RequirePermission('stock:read')
  @Get(':id')
  async get(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return toView(await this.reservations.get(tenantId, id));
  }

  @RequirePermission('reservations:write')
  @Post(':id/confirm')
  @HttpCode(200)
  async confirm(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return toView((await this.reservations.confirm(tenantId, id)).reservation);
  }

  @RequirePermission('reservations:write')
  @Post(':id/release')
  @HttpCode(200)
  async release(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return toView((await this.reservations.release(tenantId, id)).reservation);
  }
}

function toView(reservation: ReservationWithItems) {
  return {
    id: reservation.id,
    reference: reservation.reference,
    status: reservation.status,
    expiresAt: reservation.expiresAt,
    confirmedAt: reservation.confirmedAt,
    endedAt: reservation.endedAt,
    items: reservation.items.map((item) => ({
      stockItemId: item.stockItemId,
      quantity: item.quantity,
    })),
  };
}
