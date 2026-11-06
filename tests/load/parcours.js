// Charge réaliste : des vendeurs consultent le stock, créent des commandes (Idempotency-Key, parfois rejouées),
// les clients paient (notification signée) ou abandonnent (annulation). Mesure les latences par route.
//   PAYMENT_WEBHOOK_SECRET=… k6 run tests/load/parcours.js
//   VUS=100 DURATION=2m k6 run …   pour pousser plus fort ; ARTICLES=1 pour la ligne chaude
import http from 'k6/http';
import { check, sleep } from 'k6';
import { API, pay, prepareShop, uuid, WEBHOOK_SECRET } from './lib.js';

const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || '1m';
// Nombre d'articles commandés : 1 = toutes les commandes sur la même ligne de stock (ligne chaude).
const ARTICLES = Number(__ENV.ARTICLES || 20);

export const options = {
  scenarios: {
    vendeurs: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '10s', target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '5s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    // Objectifs de service de départ, mesurés sur un poste de développement (tests/load/RESULTATS.md).
    'http_req_duration{name:GET /inventory}': [
      `p(95)<${__ENV.P95_READ || 200}`,
    ],
    'http_req_duration{name:POST /orders}': [`p(95)<${__ENV.P95_WRITE || 400}`],
    'http_req_duration{name:GET /orders/:id}': [
      `p(95)<${__ENV.P95_READ || 200}`,
    ],
    'http_req_duration{name:POST /payments/webhook}': [
      `p(95)<${__ENV.P95_WRITE || 400}`,
    ],
  },
};

export function setup() {
  if (!WEBHOOK_SECRET) throw new Error('PAYMENT_WEBHOOK_SECRET manquant');
  // Stock large : on mesure la latence du parcours, pas la contention (voir contention.js).
  return prepareShop(1_000_000, '19.90', ARTICLES);
}

export default function (shop) {
  const headers = { 'content-type': 'application/json', ...shop.headers };

  const stock = http.get(`${API}/inventory?warehouseId=${shop.warehouseId}`, {
    headers,
    tags: { name: 'GET /inventory' },
  });
  check(stock, { 'stock lu': (r) => r.status === 200 });

  const key = uuid();
  const body = JSON.stringify({
    warehouseId: shop.warehouseId,
    items: [
      {
        variantId:
          shop.variantIds[Math.floor(Math.random() * shop.variantIds.length)],
        quantity: 1 + Math.floor(Math.random() * 3),
      },
    ],
    customerEmail: `client-${key.slice(0, 8)}@example.com`,
  });
  const params = {
    headers: { ...headers, 'idempotency-key': key },
    tags: { name: 'POST /orders' },
  };
  const created = http.post(`${API}/orders`, body, params);
  check(created, { 'commande créée': (r) => r.status === 201 });
  if (created.status !== 201) return;
  // Un client sur dix renvoie sa requête (réseau coupé, double clic) : même commande attendue.
  if (Math.random() < 0.1) {
    const replay = http.post(`${API}/orders`, body, params);
    check(replay, {
      'rejeu : même commande': (r) =>
        r.status === 201 &&
        r.headers['Idempotent-Replayed'] === 'true' &&
        r.json('id') === created.json('id'),
    });
  }
  const order = created.json();

  sleep(0.2 + Math.random() * 0.3);
  if (Math.random() < 0.8) {
    pay(order);
  } else {
    const cancelled = http.post(`${API}/orders/${order.id}/cancel`, null, {
      headers,
      tags: { name: 'POST /orders/:id/cancel' },
    });
    check(cancelled, { 'commande annulée': (r) => r.status === 200 });
  }

  const read = http.get(`${API}/orders/${order.id}`, {
    headers,
    tags: { name: 'GET /orders/:id' },
  });
  check(read, { 'commande relue': (r) => r.status === 200 });
  sleep(0.5 + Math.random());
}
