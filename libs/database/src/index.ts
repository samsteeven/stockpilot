export * from './lib/database.module.js';
export * from './lib/prisma.service.js';
export * from './lib/tenant-database.js';
export * from './lib/errors.js';
export {
  Prisma,
  ReservationStatus,
  StockMovementType,
} from './generated/prisma/client.js';
export type {
  Reservation,
  ReservationItem,
  StockItem,
  StockMovement,
} from './generated/prisma/client.js';
