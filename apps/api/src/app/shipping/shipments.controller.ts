import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { NotificationService } from '@stockpilot/notifications';
import { ShipmentService } from '@stockpilot/shipping';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  CurrentAccess,
  CurrentTenant,
  RequirePermission,
  type TenantAccess,
} from '../common/access';

export class ShipmentQueryDto {
  @IsOptional()
  @IsIn(['READY_TO_SHIP', 'SHIPPED', 'DELIVERED'])
  status?: 'READY_TO_SHIP' | 'SHIPPED' | 'DELIVERED';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class ShipDto {
  @IsString()
  @Length(2, 60)
  carrier!: string;

  @Matches(/^[A-Za-z0-9-]{4,40}$/)
  trackingNumber!: string;
}

export class LimitDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

@Controller('shipments')
export class ShipmentsController {
  constructor(private readonly shipments: ShipmentService) {}

  @RequirePermission('orders:read')
  @Get()
  list(@CurrentTenant() tenantId: string, @Query() query: ShipmentQueryDto) {
    return this.shipments.list(tenantId, query);
  }

  @RequirePermission('orders:read')
  @Get(':id')
  get(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.shipments.get(tenantId, id);
  }

  @RequirePermission('shipments:write')
  @Post(':id/ship')
  @HttpCode(200)
  ship(
    @CurrentAccess() access: TenantAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ShipDto,
  ) {
    return this.shipments.ship(access.tenantId, access.userId, id, body);
  }

  @RequirePermission('shipments:write')
  @Post(':id/deliver')
  @HttpCode(200)
  deliver(
    @CurrentAccess() access: TenantAccess,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.shipments.deliver(access.tenantId, access.userId, id);
  }
}

/** Messages envoyés aux clients : ils contiennent leurs adresses, réservés au propriétaire et à l'administrateur. */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  @RequirePermission('notifications:read')
  @Get()
  list(@CurrentTenant() tenantId: string, @Query() query: LimitDto) {
    return this.notifications.list(tenantId, query.limit);
  }
}
