/** Libellés français des états et rôles renvoyés par l'API. */

export const ORDER_STATUS: Record<string, string> = {
  PENDING_PAYMENT: 'En attente de paiement',
  CONFIRMED: 'Confirmée',
  CANCELLED: 'Annulée',
};

export const SHIPMENT_STATUS: Record<string, string> = {
  READY_TO_SHIP: 'À expédier',
  SHIPPED: 'Expédiée',
  DELIVERED: 'Livrée',
};

export const PAYMENT_STATUS: Record<string, string> = {
  PENDING: 'Attendu',
  SUCCEEDED: 'Reçu',
  FAILED: 'Refusé',
  REFUND_REQUIRED: 'À rembourser',
};

export const CANCEL_REASON: Record<string, string> = {
  cancelled_by_user: 'annulée par un membre',
  payment_failed: 'paiement refusé',
  reservation_expired: 'paiement non reçu à temps',
};

export const ROLE: Record<string, string> = {
  OWNER: 'Propriétaire',
  ADMIN: 'Administrateur',
  WAREHOUSE_MANAGER: 'Responsable d’entrepôt',
  OPERATOR: 'Opérateur',
  VIEWER: 'Lecteur',
};

export function shortRef(id: string): string {
  return id.slice(0, 8).toUpperCase();
}
