// Démonstration : 20 commandes simultanées pour les derniers casques noirs de Paris, contre l'API démarrée.
//   node scripts/demo-concurrence.mjs [http://127.0.0.1:3000]
// Prérequis : base migrée et données de démonstration (npm run db:seed), API et worker démarrés.
// Les 20 commandes partent avec le même compte : la concurrence est sur le stock, pas sur la connexion.
const api = (process.argv[2] ?? 'http://127.0.0.1:3000') + '/api/v1';
const TENANT = '0a1e5c3e-5b7a-4c1e-9f00-000000000001';

// Connexion avec le compte de démonstration (npm run db:seed), comme le ferait le front.
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
const PARIS = '0a1e5c3e-5b7a-4c1e-9f00-0000000000a1';
const CASQUE_NOIR = '0a1e5c3e-5b7a-4c1e-9f00-0000000000c1';

async function stock() {
  const response = await fetch(`${api}/inventory?warehouseId=${PARIS}`, {
    headers,
  });
  return (await response.json()).find((line) => line.variantId === CASQUE_NOIR);
}

const before = await stock();
console.log(
  `Avant : ${before.onHand} en stock, ${before.reserved} réservés, ${before.available} disponibles`,
);

const started = performance.now();
const responses = await Promise.all(
  Array.from({ length: 20 }, (_, i) =>
    fetch(`${api}/reservations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        reference: `demo-${Date.now()}-${i}`,
        warehouseId: PARIS,
        items: [{ variantId: CASQUE_NOIR, quantity: 1 }],
      }),
    }),
  ),
);
const elapsed = Math.round(performance.now() - started);
const byStatus = responses.reduce(
  (acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }),
  {},
);

const after = await stock();
console.log(
  `20 commandes simultanées en ${elapsed} ms : ${JSON.stringify(byStatus)} (201 = réservé, 409 = stock insuffisant)`,
);
console.log(
  `Après : ${after.onHand} en stock, ${after.reserved} réservés, ${after.available} disponibles`,
);
if (byStatus[201] !== before.available || after.available !== 0) {
  console.error(
    'INCOHÉRENCE : le nombre de réservations ne correspond pas au disponible',
  );
  process.exit(1);
}
console.log('Aucune survente.');
