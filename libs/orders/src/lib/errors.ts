export class OrderNotFoundError extends Error {
  constructor(readonly orderId: string) {
    super(`commande ${orderId} introuvable`);
  }
}

/** Même clé d'idempotence, requête différente : refusé plutôt que de rendre la réponse d'une autre requête. */
export class IdempotencyKeyReuseError extends Error {
  constructor() {
    super('cette clé d’idempotence a déjà servi pour une autre requête');
  }
}

export class UnknownVariantError extends Error {
  constructor(readonly variantIds: string[]) {
    super(`article(s) inconnu(s) : ${variantIds.join(', ')}`);
  }
}

export class UnknownWarehouseError extends Error {
  constructor(readonly warehouseId: string) {
    super(`entrepôt ${warehouseId} inconnu`);
  }
}

export class MixedCurrencyError extends Error {
  constructor(readonly currencies: string[]) {
    super(
      `une commande est dans une seule devise (reçu : ${currencies.join(', ')})`,
    );
  }
}

export class OrderNotCancellableError extends Error {
  constructor(
    readonly orderId: string,
    readonly status: string,
  ) {
    super(`commande ${orderId} : ${status}, plus annulable`);
  }
}

/** Signature absente, fausse ou trop ancienne : la notification ne vient pas (ou plus) du prestataire. */
export class InvalidSignatureError extends Error {
  constructor(reason: string) {
    super(`signature refusée : ${reason}`);
  }
}

export class InvalidPaymentEventError extends Error {}

export class PaymentNotFoundError extends Error {
  constructor(readonly providerReference: string) {
    super(`paiement ${providerReference} inconnu`);
  }
}

/** Montant ou devise annoncés par le prestataire différents de ceux attendus : rien n'est confirmé. */
export class PaymentMismatchError extends Error {}
