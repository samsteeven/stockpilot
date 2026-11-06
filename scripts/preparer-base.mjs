// Prépare une base PostgreSQL gérée (RDS) avant les migrations, comme le fait le script d'initialisation de
// docker compose en local : rôle de groupe `stockpilot_runtime` (sans connexion) et rôle de connexion
// `stockpilot_app` (membre du groupe, soumis à la Row-Level Security). Idempotent : relancé à chaque déploiement,
// il remet aussi le mot de passe applicatif à la valeur du secret (rotation).
//   DATABASE_URL=… APP_DATABASE_PASSWORD=… node scripts/preparer-base.mjs
import pg from 'pg';

const url = process.env.DATABASE_URL;
const appPassword = process.env.APP_DATABASE_PASSWORD;
if (!url || !appPassword) {
  console.error('DATABASE_URL et APP_DATABASE_PASSWORD sont requis');
  process.exit(2);
}

// L'URL est celle des migrations (dialecte Prisma : sslmode, sslaccept) ; pg ferait passer ses paramètres TLS avant
// l'option explicite, ils sont donc retirés. RDS impose TLS : connexion chiffrée (certificat non vérifié, ADR-016).
const parsed = new URL(url);
const tls =
  parsed.searchParams.has('sslmode') &&
  parsed.searchParams.get('sslmode') !== 'disable';
for (const key of ['sslmode', 'sslaccept', 'sslcert', 'sslrootcert'])
  parsed.searchParams.delete(key);
const client = new pg.Client({
  connectionString: parsed.toString(),
  ...(tls ? { ssl: { rejectUnauthorized: false } } : {}),
});
await client.connect();
try {
  await client.query(`DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stockpilot_runtime') THEN
        CREATE ROLE stockpilot_runtime NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stockpilot_app') THEN
        CREATE ROLE stockpilot_app LOGIN IN ROLE stockpilot_runtime;
      END IF;
    END $$`);
  // Le mot de passe n'est jamais interpolé dans le SQL : il passe par une fonction de citation côté serveur.
  const { rows } = await client.query('SELECT format($1, $2::text) AS sql', [
    'ALTER ROLE stockpilot_app WITH LOGIN PASSWORD %L',
    appPassword,
  ]);
  await client.query(rows[0].sql);
  console.log('Rôles stockpilot_runtime et stockpilot_app prêts.');
} finally {
  await client.end();
}
