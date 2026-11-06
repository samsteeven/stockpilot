export class DuplicateSkuError extends Error {
  constructor(readonly sku: string) {
    super(`la référence ${sku} existe déjà dans cette entreprise`);
  }
}

export class DuplicateWarehouseCodeError extends Error {
  constructor(readonly code: string) {
    super(`le code d’entrepôt ${code} existe déjà dans cette entreprise`);
  }
}

export class ProductNotFoundError extends Error {
  constructor() {
    super('produit introuvable');
  }
}
