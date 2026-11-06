/**
 * Planification de l'expiration d'une réservation. Port du domaine : l'implémentation BullMQ est dans le worker
 * et l'API ; les tests en fournissent une en mémoire.
 *
 * Le job n'est jamais la source de vérité : il peut se perdre (Redis indisponible au mauvais moment), arriver en
 * retard ou deux fois. L'expiration recontrôle l'état en base, et un balayage périodique rattrape les oubliés.
 */
export interface ReservationExpiryScheduler {
  schedule(
    tenantId: string,
    reservationId: string,
    expiresAt: Date,
  ): Promise<void>;
}

export const RESERVATION_EXPIRY_SCHEDULER = Symbol(
  'RESERVATION_EXPIRY_SCHEDULER',
);

export const RESERVATION_EXPIRY_QUEUE = 'reservation-expiry';

export interface ExpireReservationJob {
  tenantId: string;
  reservationId: string;
}
