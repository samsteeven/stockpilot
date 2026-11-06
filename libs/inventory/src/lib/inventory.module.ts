import { Module } from '@nestjs/common';
import { ReservationService } from './reservation.service.js';
import { StockService } from './stock.service.js';

/**
 * Module stock et réservations. Dépend de DatabaseModule (global) ; le planificateur d'expiration est fourni par
 * l'application qui l'importe (BullMQ dans l'API et le worker).
 */
@Module({
  providers: [ReservationService, StockService],
  exports: [ReservationService, StockService],
})
export class InventoryModule {}
