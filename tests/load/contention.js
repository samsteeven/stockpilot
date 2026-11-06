// Contention : 200 clients veulent les 50 dernières unités au même instant.
// Garantie vérifiée : exactement 50 réservations passent, les autres reçoivent 409, rien n'est survendu.
//   k6 run tests/load/contention.js
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { API, prepareShop, stockOf, uuid } from './lib.js';

const UNITS = Number(__ENV.UNITS || 50);
const BUYERS = Number(__ENV.BUYERS || 200);

const reserved = new Counter('reservations_acceptees');
const refused = new Counter('reservations_refusees');

// 409 (stock insuffisant) est une réponse attendue, pas une erreur.
http.setResponseCallback(http.expectedStatuses(200, 201, 409));

export const options = {
  scenarios: {
    rafale: {
      executor: 'per-vu-iterations',
      vus: BUYERS,
      iterations: 1,
      maxDuration: '1m',
    },
  },
  thresholds: {
    // Exactement UNITS réservations acceptées : ni plus (survente), ni moins (refus à tort).
    reservations_acceptees: [`count==${UNITS}`],
    reservations_refusees: [`count==${BUYERS - UNITS}`],
    http_req_failed: ['rate==0'],
    'http_req_duration{name:POST /reservations}': [
      `p(95)<${__ENV.P95_CONTENTION || 1500}`,
    ],
    checks: ['rate==1'],
  },
};

export function setup() {
  return prepareShop(UNITS);
}

export default function (shop) {
  const response = http.post(
    `${API}/reservations`,
    JSON.stringify({
      reference: `charge-${uuid()}`,
      warehouseId: shop.warehouseId,
      items: [{ variantId: shop.variantId, quantity: 1 }],
    }),
    {
      headers: { 'content-type': 'application/json', ...shop.headers },
      tags: { name: 'POST /reservations' },
    },
  );
  if (response.status === 201) reserved.add(1);
  if (response.status === 409) refused.add(1);
  check(response, {
    '201 ou 409': (r) => r.status === 201 || r.status === 409,
  });
}

export function teardown(shop) {
  const line = stockOf(shop);
  check(line, {
    'réservé = physique, jamais au-delà': (l) =>
      l.reserved === UNITS && l.onHand === UNITS,
    'disponible = 0': (l) => l.available === 0,
  });
}
