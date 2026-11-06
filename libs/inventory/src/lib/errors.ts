/** Erreurs du domaine stock : traduites en réponses HTTP par l'API, jamais en 500. */

export interface Shortage {
  variantId: string;
  requested: number;
  available: number;
}

export class InsufficientStockError extends Error {
  constructor(readonly shortages: Shortage[]) {
    super(`stock insuffisant pour ${shortages.length} article(s)`);
  }
}

export class ReservationNotFoundError extends Error {
  constructor(readonly reservationId: string) {
    super('réservation introuvable');
  }
}

export class ReservationNotActiveError extends Error {
  constructor(
    readonly reservationId: string,
    readonly status: string,
  ) {
    super(`réservation déjà ${status.toLowerCase()}`);
  }
}

export class ReservationExpiredError extends Error {
  constructor(readonly reservationId: string) {
    super('réservation expirée : le stock a été ou va être libéré');
  }
}

export class UnknownStockItemError extends Error {
  constructor(readonly variantId: string) {
    super('article inconnu dans cet entrepôt');
  }
}
