// Démonstration du parcours commande → paiement contre l'API démarrée, le prestataire de paiement étant simulé
// par ce script (il signe ses notifications avec le secret partagé, comme le ferait un vrai prestataire).
//   PAYMENT_WEBHOOK_SECRET=… node scripts/demo-commande.mjs [http://127.0.0.1:3000]
// Prérequis : base migrée et données de démonstration (npm run db:seed), API et worker démarrés.
// Le troisième scénario attend l'expiration de la réservation : à lancer avec un RESERVATION_TTL_SECONDS court.
import { createHmac, randomUUID } from 'node:crypto';

const api = (process.argv[2] ?? 'http://127.0.0.1:3000') + '/api/v1';
const secret = process.env.PAYMENT_WEBHOOK_SECRET;
if (!secret) throw new Error('PAYMENT_WEBHOOK_SECRET manquant');
const TENANT = '0a1e5c3e-5b7a-4c1e-9f00-000000000001';
const PARIS = '0a1e5c3e-5b7a-4c1e-9f00-0000000000a1';
const CABLE = '0a1e5c3e-5b7a-4c1e-9f00-0000000000c3';

const login = await fetch(`${api}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'demo@atelier-nova.example',
    password: 'demonstration-stockpilot',
  }),
});
if (!login.ok) throw new Error(`connexion refusée : HTTP ${login.status}`);
const { accessToken } = await login.json();
const headers = {
  'content-type': 'application/json',
  authorization: `Bearer ${accessToken}`,
  'x-tenant-id': TENANT,
};

let failures = 0;
function check(label, ok, detail = '') {
  console.log(
    `${ok ? 'OK  ' : 'ÉCHEC'} ${label}${detail ? ` (${detail})` : ''}`,
  );
  if (!ok) failures++;
}

async function placeOrder(key, quantity) {
  const response = await fetch(`${api}/orders`, {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': key },
    body: JSON.stringify({
      warehouseId: PARIS,
      items: [{ variantId: CABLE, quantity }],
    }),
  });
  return {
    status: response.status,
    replayed: response.headers.get('idempotent-replayed') === 'true',
    body: await response.json(),
  };
}

async function notify(order, type, id = `evt_${randomUUID()}`) {
  const body = JSON.stringify({
    id,
    type,
    data: {
      providerReference: order.payment.providerReference,
      amount: order.payment.amount,
      currency: order.payment.currency,
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const mac = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  const response = await fetch(`${api}/payments/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stockpilot-signature': `t=${timestamp},v1=${mac}`,
    },
    body,
  });
  return { status: response.status, body: await response.json() };
}

async function getOrder(id) {
  return (await fetch(`${api}/orders/${id}`, { headers })).json();
}

// 1. Commande payée, requête et notification envoyées deux fois.
console.log(
  '\n1. Commande de 3 câbles, envoyée deux fois avec la même clé, puis payée',
);
const key = randomUUID();
const first = await placeOrder(key, 3);
const again = await placeOrder(key, 3);
check(
  'commande créée',
  first.status === 201,
  `${first.body.totalAmount} ${first.body.currency}`,
);
check(
  'total calculé par le serveur (3 × 12,50)',
  first.body.totalAmount === '37.50',
);
check(
  'même clé : même commande, réponse rejouée',
  again.status === 201 && again.replayed && again.body.id === first.body.id,
);
const conflict = await placeOrder(key, 4);
check('même clé, autre contenu : refusée', conflict.status === 422);
const eventId = `evt_${randomUUID()}`;
const paid = await notify(first.body, 'payment.succeeded', eventId);
const paidAgain = await notify(first.body, 'payment.succeeded', eventId);
check(
  'paiement accepté : commande confirmée',
  paid.body.outcome === 'confirmed',
);
check(
  'notification renvoyée : sans effet',
  paidAgain.body.outcome === 'duplicate',
);
check('statut', (await getOrder(first.body.id)).status === 'CONFIRMED');

// 2. Paiement refusé : compensation, la réservation est rendue.
console.log('\n2. Commande dont le paiement est refusé');
const refused = await placeOrder(randomUUID(), 2);
const failed = await notify(refused.body, 'payment.failed');
const refusedOrder = await getOrder(refused.body.id);
check(
  'commande annulée',
  failed.body.outcome === 'cancelled' && refusedOrder.status === 'CANCELLED',
  refusedOrder.cancelReason,
);

// 3. Pas de paiement à temps : le worker annule (réservation expirée → outbox → file → commande annulée), puis
// un paiement tardif exige un remboursement.
console.log('\n3. Commande non payée à temps, puis paiement tardif');
const late = await placeOrder(randomUUID(), 1);
let lateOrder;
for (let i = 0; i < 60; i++) {
  lateOrder = await getOrder(late.body.id);
  if (lateOrder.status !== 'PENDING_PAYMENT') break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
check(
  'annulée par le worker à l’échéance',
  lateOrder.status === 'CANCELLED' &&
    lateOrder.cancelReason === 'reservation_expired',
  lateOrder.status,
);
const latePayment = await notify(late.body, 'payment.succeeded');
check(
  'paiement tardif : remboursement exigé',
  latePayment.body.outcome === 'refund-required',
);

const audit = await (await fetch(`${api}/audit?limit=200`, { headers })).json();
const actions = new Set(audit.map((entry) => entry.action));
check(
  'journal d’audit',
  [
    'order.created',
    'payment.succeeded',
    'payment.failed',
    'payment.refund_required',
  ].every((a) => actions.has(a)),
  [...actions].join(', '),
);

if (failures > 0) {
  console.error(`\n${failures} vérification(s) en échec`);
  process.exit(1);
}
console.log('\nToutes les vérifications passent.');
