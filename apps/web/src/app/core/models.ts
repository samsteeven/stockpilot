/** Réponses de l'API StockPilot, telles que le front les utilise. */

export type Permission =
  | 'stock:read'
  | 'stock:receive'
  | 'reservations:write'
  | 'catalog:write'
  | 'warehouses:write'
  | 'members:read'
  | 'members:manage'
  | 'orders:read'
  | 'orders:write'
  | 'audit:read'
  | 'shipments:write'
  | 'notifications:read';

export interface Membership {
  tenantId: string;
  name: string;
  slug: string;
  role: string;
  permissions: Permission[];
}

export interface Profile {
  userId: string;
  email: string;
  tenants: Membership[];
}

export interface SessionTokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  userId: string;
}

export interface Warehouse {
  id: string;
  code: string;
  name: string;
}

export interface Variant {
  id: string;
  sku: string;
  name: string;
  unitPrice: string;
  currency: string;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  variants: Variant[];
}

export interface StockLevel {
  stockItemId: string;
  warehouseId: string;
  variantId: string;
  sku: string;
  onHand: number;
  reserved: number;
  available: number;
}

export type OrderStatus = 'PENDING_PAYMENT' | 'CONFIRMED' | 'CANCELLED';
export type ShipmentStatus = 'READY_TO_SHIP' | 'SHIPPED' | 'DELIVERED';

export interface Order {
  id: string;
  status: OrderStatus;
  warehouseId: string;
  currency: string;
  totalAmount: string;
  customerEmail: string | null;
  reservationId: string | null;
  cancelReason: string | null;
  createdAt: string;
  items: { variantId: string; quantity: number; unitPrice: string }[];
  payment: {
    providerReference: string;
    status: string;
    amount: string;
    currency: string;
  } | null;
  shipment?: {
    id: string;
    status: ShipmentStatus;
    carrier: string | null;
    trackingNumber: string | null;
  } | null;
  payBefore?: string;
  history?: {
    from: OrderStatus | null;
    to: OrderStatus;
    reason: string | null;
    actorId: string | null;
    at: string;
  }[];
}

export interface Shipment {
  id: string;
  orderId: string;
  warehouseId: string;
  status: ShipmentStatus;
  carrier: string | null;
  trackingNumber: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

/** Erreur au format Problem Details (RFC 9457). */
export interface Problem {
  title?: string;
  detail?: string;
  status?: number;
}
