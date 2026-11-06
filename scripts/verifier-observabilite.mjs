// Vérifie la chaîne d'observabilité de bout en bout, une fois du trafic passé (scripts/demo-commande.mjs) :
// Prometheus lit l'API et le worker, les métriques métier existent, les alertes sont chargées, Grafana a son
// tableau de bord.
//   node scripts/verifier-observabilite.mjs [http://127.0.0.1:9090] [http://127.0.0.1:3001]
const prometheus = process.argv[2] ?? 'http://127.0.0.1:9090';
const grafana = process.argv[3] ?? 'http://127.0.0.1:3001';

async function query(expr) {
  const response = await fetch(
    `${prometheus}/api/v1/query?query=${encodeURIComponent(expr)}`,
  );
  const body = await response.json();
  return body.data?.result ?? [];
}

/** Répète jusqu'à ce que la condition tienne (Prometheus lit toutes les 5 s). */
async function eventually(label, read, accept, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await read();
      if (accept(last)) {
        console.log(`OK    ${label}`);
        return last;
      }
    } catch (error) {
      last = error.message;
    }
    if (Date.now() > deadline) {
      console.error(`ÉCHEC ${label} : ${JSON.stringify(last)}`);
      process.exitCode = 1;
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

const value = (result) => Number(result[0]?.value?.[1] ?? NaN);

await eventually(
  'Prometheus lit l’API et le worker',
  () => query('up{job=~"api|worker"}'),
  (r) => r.length === 2 && r.every((s) => s.value[1] === '1'),
);
await eventually(
  'durées HTTP par gabarit de route',
  () =>
    query(
      'count(stockpilot_http_request_duration_seconds_count{route="/api/v1/orders/:id"})',
    ),
  (r) => value(r) >= 1,
);
await eventually(
  'commandes créées et rejouées comptées',
  () => query('sum by (outcome) (stockpilot_orders_total)'),
  (r) =>
    ['created', 'replayed'].every((o) => r.some((s) => s.metric.outcome === o)),
);
await eventually(
  'notifications de paiement comptées par issue',
  () => query('sum by (outcome) (stockpilot_payment_notifications_total)'),
  (r) => r.some((s) => s.metric.outcome === 'confirmed'),
);
await eventually(
  'événements traités par le worker',
  () => query('sum(stockpilot_domain_events_total)'),
  (r) => value(r) > 0,
);
await eventually(
  'outbox mesurée (et rattrapée)',
  () => query('stockpilot_outbox_oldest_age_seconds'),
  (r) => r.length === 1 && value(r) < 60,
);
await eventually(
  'règles d’alerte chargées',
  async () => {
    const response = await fetch(`${prometheus}/api/v1/rules`);
    const body = await response.json();
    return body.data.groups.flatMap((g) => g.rules.map((rule) => rule.name));
  },
  (names) => names.length >= 7 && names.includes('StockPilotOutboxEnRetard'),
);
await eventually(
  'aucune alerte active après le trafic de démonstration',
  async () => {
    const response = await fetch(`${prometheus}/api/v1/alerts`);
    return (await response.json()).data.alerts.filter(
      (a) => a.state === 'firing',
    );
  },
  (firing) => firing.length === 0,
  10_000,
);
await eventually(
  'tableau de bord Grafana provisionné',
  async () => {
    const response = await fetch(`${grafana}/api/dashboards/uid/stockpilot`);
    return response.ok
      ? (await response.json()).dashboard.panels.length
      : response.status;
  },
  (panels) => typeof panels === 'number' && panels >= 10,
);

if (process.exitCode) console.error('\nChaîne d’observabilité incomplète.');
else console.log('\nChaîne d’observabilité complète.');
