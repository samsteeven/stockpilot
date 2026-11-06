import { DynamicModule, Module } from '@nestjs/common';
import { InventoryModule } from '@stockpilot/inventory';
import {
  ORDERS_OPTIONS,
  OrderService,
  type OrdersOptions,
} from './order.service.js';
import { PaymentService } from './payment.service.js';

@Module({})
export class OrdersModule {
  static forRoot(options: OrdersOptions): DynamicModule {
    if (
      options.paymentWebhookSecret !== undefined &&
      options.paymentWebhookSecret.length < 32
    ) {
      throw new Error(
        'PAYMENT_WEBHOOK_SECRET doit compter au moins 32 caractères',
      );
    }
    return {
      module: OrdersModule,
      imports: [InventoryModule],
      providers: [
        { provide: ORDERS_OPTIONS, useValue: options },
        OrderService,
        PaymentService,
      ],
      exports: [OrderService, PaymentService],
    };
  }
}
