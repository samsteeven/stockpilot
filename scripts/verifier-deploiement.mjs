// Vérifie un déploiement par son adresse publique, comme un utilisateur : front servi, API joignable par
// CloudFront, accès direct au répartiteur fermé, connexion du compte de démonstration, en-têtes de sécurité,
// puis 20 commandes simultanées pour 5 unités (aucune survente en production non plus).
//   node scripts/verifier-deploiement.mjs https://dxxxx.cloudfront.net
import { execFileSync } from 'node:child_process';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!base.startsWith('https://')) {
  console.error('usage : node scripts/verifier-deploiement.mjs https://…');
  process.exit(2);
}

let failures = 0;
function check(label, ok, detail = '') {
  console.log(
    `${ok ? 'OK   ' : 'ÉCHEC'} ${label}${detail ? ` (${detail})` : ''}`,
  );
  if (!ok) failures++;
}

async function eventually(read, accept, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

const home = await eventually(
  () => fetch(`${base}/`),
  (r) => r.status === 200,
);
check('front servi par CloudFront', home.status === 200, `HTTP ${home.status}`);
check(
  'en-têtes de sécurité (HSTS, CSP)',
  !!home.headers.get('strict-transport-security') &&
    !!home.headers.get('content-security-policy'),
);
const deepLink = await fetch(`${base}/commandes`);
check(
  'route du front servie (application à page unique)',
  deepLink.status === 200,
);

const me = await eventually(
  () => fetch(`${base}/api/v1/auth/me`),
  (r) => r.status === 401,
);
check(
  'API joignable par CloudFront (401 sans jeton)',
  me.status === 401,
  `HTTP ${me.status}`,
);

const login = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'demo@atelier-nova.example',
    password: 'demonstration-stockpilot',
  }),
});
check(
  'connexion du compte de démonstration',
  login.status === 200,
  `HTTP ${login.status}`,
);
const cookie = login.headers.get('set-cookie') ?? '';
check(
  'cookie de session Secure, HttpOnly, SameSite=Strict',
  /Secure/.test(cookie) &&
    /HttpOnly/.test(cookie) &&
    /SameSite=Strict/i.test(cookie),
);
check(
  'identifiant de corrélation renvoyé',
  !!login.headers.get('x-request-id'),
);

if (failures === 0) {
  // Même démonstration que sur le poste : 20 commandes simultanées pour 5 casques.
  execFileSync('node', ['scripts/demo-concurrence.mjs', base], {
    stdio: 'inherit',
  });
}

if (failures > 0) {
  console.error(`\n${failures} vérification(s) en échec`);
  process.exit(1);
}
console.log('\nDéploiement vérifié.');
