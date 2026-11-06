// Aides communes aux tests de charge k6 : chaque exécution crée sa propre entreprise par l'API (inscription,
// entrepôt, article, stock), pour ne dépendre ni des données de démonstration ni d'une exécution précédente.
import http from 'k6/http';
import crypto from 'k6/crypto';
import { check, fail } from 'k6';

export const API = (__ENV.API_URL || 'http://127.0.0.1:3000') + '/api/v1';
export const WEBHOOK_SECRET = __ENV.PAYMENT_WEBHOOK_SECRET || '';

export function uuid() {
  return hex(crypto.randomBytes(16));
}

function hex(buffer) {
  const bytes = new Uint8Array(buffer);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function json(method, path, body, headers = {}, expected = [200, 201]) {
  const response = http.request(
    method,
    `${API}${path}`,
    body === undefined ? null : JSON.stringify(body),
    {
      headers: { 'content-type': 'application/json', ...headers },
      tags: { name: `prepare ${path}` },
    },
  );
  if (!expected.includes(response.status)) {
    fail(`${method} ${path} : HTTP ${response.status} ${response.body}`);
  }
  return response.json();
}

/**
 * Une entreprise neuve : un entrepôt, `articles` articles au prix donné, `quantity` unités de chacun en stock.
 * Avec un seul article, toutes les commandes verrouillent la même ligne de stock (cas le plus défavorable).
 */
export function prepareShop(quantity, unitPrice = '10.00', articles = 1) {
  const suffix = uuid().slice(0, 8);
  const account = json('POST', '/auth/register', {
    email: `charge-${suffix}@stockpilot.test`,
    password: 'mot-de-passe-de-charge-0123',
    companyName: `Charge ${suffix}`,
  });
  const headers = {
    authorization: `Bearer ${account.accessToken}`,
    'x-tenant-id': account.tenantId,
  };
  const warehouse = json(
    'POST',
    '/warehouses',
    { code: 'CHG', name: 'Entrepôt de charge' },
    headers,
  );
  const product = json(
    'POST',
    '/products',
    {
      sku: `CHG-${suffix}`,
      name: 'Article de charge',
      variants: Array.from({ length: articles }, (_, i) => ({
        sku: `CHG-${suffix}-${i}`,
        name: `Variante ${i}`,
        unitPrice,
      })),
    },
    headers,
  );
  const variantIds = product.variants.map((v) => v.id);
  for (const variantId of variantIds)
    json(
      'POST',
      '/inventory/receipts',
      { warehouseId: warehouse.id, variantId, quantity },
      headers,
    );
  return {
    headers,
    warehouseId: warehouse.id,
    variantId: variantIds[0],
    variantIds,
    tenantId: account.tenantId,
  };
}

export function stockOf(shop) {
  const response = http.get(
    `${API}/inventory?warehouseId=${shop.warehouseId}`,
    {
      headers: shop.headers,
      tags: { name: 'GET /inventory' },
    },
  );
  return response.json().find((line) => line.variantId === shop.variantId);
}

/** Notification signée, comme l'enverrait le prestataire de paiement. */
export function pay(order, type = 'payment.succeeded') {
  const body = JSON.stringify({
    id: `evt_${uuid()}`,
    type,
    data: {
      providerReference: order.payment.providerReference,
      amount: order.payment.amount,
      currency: order.payment.currency,
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const mac = crypto.hmac(
    'sha256',
    WEBHOOK_SECRET,
    `${timestamp}.${body}`,
    'hex',
  );
  const response = http.post(`${API}/payments/webhook`, body, {
    headers: {
      'content-type': 'application/json',
      'stockpilot-signature': `t=${timestamp},v1=${mac}`,
    },
    tags: { name: 'POST /payments/webhook' },
  });
  check(response, { 'paiement accepté': (r) => r.status === 200 });
  return response;
}
