import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { AuditService } from '@stockpilot/audit';
import {
  OrderService,
  PaymentService,
  SIGNATURE_HEADER,
  toView,
} from '@stockpilot/orders';
import type { Request, Response } from 'express';
import {
  CurrentAccess,
  CurrentTenant,
  Public,
  RequirePermission,
  type TenantAccess,
} from '../common/access';
import {
  AuditQueryDto,
  IDEMPOTENCY_KEY,
  OrderQueryDto,
  PlaceOrderDto,
} from './dto';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrderService) {}

  /**
   * Crée une commande : réserve le stock et attend le paiement. L'en-tête Idempotency-Key est obligatoire : la
   * même clé rejoue la première réponse (en-tête Idempotent-Replayed), la même clé avec une autre commande est
   * refusée (422).
   */
  @RequirePermission('orders:write')
  @Post()
  async place(
    @CurrentAccess() access: TenantAccess,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: PlaceOrderDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      throw new BadRequestException(
        'En-tête Idempotency-Key obligatoire (8 à 200 caractères : lettres, chiffres, _ . : -)',
      );
    }
    const { order, replayed } = await this.orders.place(
      access.tenantId,
      access.userId,
      { ...body, idempotencyKey: key },
    );
    response.status(201);
    if (replayed) response.setHeader('Idempotent-Replayed', 'true');
    return order;
  }

  @RequirePermission('orders:read')
  @Get()
  async list(@CurrentTenant() tenantId: string, @Query() query: OrderQueryDto) {
    const orders = await this.orders.list(tenantId, {
      status: query.status,
      limit: query.limit,
      before: query.before ? new Date(query.before) : undefined,
    });
    return orders.map((order) => toView(order));
  }

  @RequirePermission('orders:read')
  @Get(':id')
  async get(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const order = await this.orders.get(tenantId, id);
    return {
      ...toView(order),
      history: order.history.map((h) => ({
        from: h.fromStatus,
        to: h.toStatus,
        reason: h.reason,
        actorId: h.actorId,
        at: h.createdAt,
      })),
    };
  }

  @RequirePermission('orders:write')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentAccess() access: TenantAccess,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.cancel(access.tenantId, access.userId, id);
  }
}

/**
 * Notifications du prestataire de paiement. Route publique (pas de jeton : c'est le prestataire qui appelle), mais
 * chaque notification est signée (HMAC du corps brut et de son horodatage) et vérifiée avant toute lecture.
 */
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentService) {}

  @Public()
  @Post('webhook')
  @HttpCode(200)
  webhook(
    @Req() request: Request & { rawBody?: Buffer },
    @Headers(SIGNATURE_HEADER) signature: string | undefined,
  ) {
    return this.payments.handleNotification(request.rawBody, signature);
  }
}

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @RequirePermission('audit:read')
  @Get()
  list(@CurrentTenant() tenantId: string, @Query() query: AuditQueryDto) {
    return this.audit.list(tenantId, {
      limit: query.limit,
      action: query.action,
      before: query.before ? new Date(query.before) : undefined,
    });
  }
}
