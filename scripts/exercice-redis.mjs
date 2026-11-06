// Exercice : Valkey (Redis) redémarre pendant que des commandes passent. Valkey n'a pas de persistance dans la
// démonstration : files BullMQ et jobs différés sont perdus. Ce qui doit tenir : l'API continue (Redis ne sert
// qu'à planifier), les paiements sont acceptés (ils écrivent dans l'outbox, en base), et dès le retour de Valkey
// le worker publie et traite ce qui attendait (expédition créée).
//   PAYMENT_WEBHOOK_SECRET=… node scripts/exercice-redis.mjs https://xxx.cloudfront.net <groupe-de-réplication>
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const base = process.argv[2];
const group = process.argv[3];
const secret = process.env.PAYMENT_WEBHOOK_SECRET;
if (!base || !group || !secret) {
  console.error(
    'usage : PAYMENT_WEBHOOK_SECRET=… node scripts/exercice-redis.mjs <url> <groupe>',
  );
  process.exit(2);
}
const api = `${base}/api/v1`;
const TENANT = '0a1e5c3e-5b7a-4c1e-9f00-000000000001';
const PARIS = '0a1e5c3e-5b7a-4c1e-9f00-0000000000a1';
const CABLE = '0a1e5c3e-5b7a-4c1e-9f00-0000000000c3';
const lines = [];
const log = (message) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${message}`;
  console.log(line);
  lines.push(line);
  appendFileSync('exercice-redis.log', `${line}\n`);
};
const aws = (...args) => execFileSync('aws', args, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const login = await fetch(`${api}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'demo@atelier-nova.example',
    password: 'demonstration-stockpilot',
  }),
});
const { accessToken } = await login.json();
const headers = {
  'content-type': 'application/json',
  authorization: `Bearer ${accessToken}`,
  'x-tenant-id': TENANT,
};

async function order() {
  const response = await fetch(`${api}/orders`, {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      warehouseId: PARIS,
      items: [{ variantId: CABLE, quantity: 1 }],
      customerEmail: 'client-exercice@example.com',
    }),
  });
  return { status: response.status, body: await response.json() };
}

async function pay(o) {
  const body = JSON.stringify({
    id: `evt_${randomUUID()}`,
    type: 'payment.succeeded',
    data: {
      providerReference: o.payment.providerReference,
      amount: o.payment.amount,
      currency: o.payment.currency,
    },
  });
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const response = await fetch(`${api}/payments/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stockpilot-signature': `t=${t},v1=${mac}`,
    },
    body,
  });
  return (await response.json()).outcome;
}

const nodeId = `${group}-001`;
const start = Date.now();
aws(
  'elasticache',
  'reboot-cache-cluster',
  '--cache-cluster-id',
  nodeId,
  '--cache-node-ids-to-reboot',
  '0001',
);
log(`Valkey : redémarrage demandé (${nodeId})`);

// Pendant le redémarrage : l'API doit continuer à prendre des commandes.
let during = 0;
let duringOk = 0;
let first;
for (;;) {
  const status = aws(
    'elasticache',
    'describe-cache-clusters',
    '--cache-cluster-id',
    nodeId,
    '--query',
    'CacheClusters[0].CacheClusterStatus',
    '--output',
    'text',
  );
  if (status === 'available' && Date.now() - start > 20_000) break;
  const created = await order();
  during++;
  if (created.status === 201) {
    duringOk++;
    first ??= created.body;
  }
  await sleep(5_000);
}
const downSeconds = Math.round((Date.now() - start) / 1000);
log(
  `Valkey de nouveau disponible après ${downSeconds} s ; commandes pendant ce temps : ${duringOk}/${during} acceptées`,
);

if (!first) {
  log('Aucune commande acceptée pendant le redémarrage');
  process.exit(1);
}
const paidAt = Date.now();
const outcome = await pay(first);
log(`Paiement de la commande ${first.id.slice(0, 8)} : ${outcome}`);

// L'événement « commande confirmée » attendait dans l'outbox (en base) ; le worker le publie et crée l'expédition.
let shipment;
for (let i = 0; i < 60 && !shipment; i++) {
  await sleep(2_000);
  const response = await fetch(`${api}/orders/${first.id}`, { headers });
  shipment = (await response.json()).shipment;
}
const shipSeconds = Math.round((Date.now() - paidAt) / 1000);
log(
  shipment
    ? `Expédition créée ${shipSeconds} s après le paiement`
    : 'Expédition NON créée après 2 min',
);

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(
    summary,
    [
      '### Redémarrage de Valkey en plein parcours',
      '',
      ...lines.map((l) => `- ${l}`),
      '',
    ].join('\n'),
  );
}
process.exit(
  shipment && outcome === 'confirmed' && duringOk === during ? 0 : 1,
);
