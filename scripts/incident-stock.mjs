// Exercice de restauration (docs/exploitation/restauration.md) : une erreur humaine efface des quantités de stock,
// puis on les répare depuis une copie de la base restaurée à un instant antérieur (PITR de RDS).
//
//   TARGET_URL=… node scripts/incident-stock.mjs etat            quantités de l'entreprise de démonstration
//   TARGET_URL=… node scripts/incident-stock.mjs casser          « UPDATE sans WHERE précis » : physique à 0
//   SOURCE_URL=… TARGET_URL=… node scripts/incident-stock.mjs reparer
//        reprend le physique de la copie restaurée, ligne par ligne, et trace chaque correction comme mouvement
//        d'ajustement (le registre des mouvements reste la source de l'historique).
// Les URL sont celles du rôle propriétaire (dialecte Prisma accepté : les paramètres TLS sont retirés).
import pg from 'pg';

const TENANT = '0a1e5c3e-5b7a-4c1e-9f00-000000000001';
const mode = process.argv[2];

function client(url) {
  const parsed = new URL(url);
  const tls =
    parsed.searchParams.has('sslmode') &&
    parsed.searchParams.get('sslmode') !== 'disable';
  for (const key of ['sslmode', 'sslaccept', 'sslcert', 'sslrootcert'])
    parsed.searchParams.delete(key);
  return new pg.Client({
    connectionString: parsed.toString(),
    ...(tls ? { ssl: { rejectUnauthorized: false } } : {}),
  });
}

async function levels(db) {
  const { rows } = await db.query(
    `SELECT s.id, w.code AS entrepot, v.sku, s.quantity_on_hand AS physique, s.quantity_reserved AS reserve
     FROM stock_items s JOIN warehouses w ON w.id = s.warehouse_id JOIN product_variants v ON v.id = s.variant_id
     WHERE s.tenant_id = $1 ORDER BY w.code, v.sku`,
    [TENANT],
  );
  return rows;
}

const target = client(process.env.TARGET_URL ?? '');
await target.connect();
try {
  if (mode === 'etat') {
    console.table(await levels(target));
  } else if (mode === 'casser') {
    // L'erreur : une mise à jour qui devait viser une ligne en vise toutes (réservé ramené à 0 aussi, sinon la
    // contrainte « réservé ≤ physique » l'aurait refusée : elle a bien protégé une partie des données).
    const { rowCount } = await target.query(
      'UPDATE stock_items SET quantity_on_hand = 0, quantity_reserved = 0 WHERE tenant_id = $1',
      [TENANT],
    );
    console.log(
      `${rowCount} lignes de stock mises à 0 à ${new Date().toISOString()}`,
    );
    console.table(await levels(target));
  } else if (mode === 'reparer') {
    const source = client(process.env.SOURCE_URL ?? '');
    await source.connect();
    try {
      const before = new Map((await levels(source)).map((l) => [l.id, l]));
      await target.query('BEGIN');
      let fixed = 0;
      for (const line of await levels(target)) {
        const good = before.get(line.id);
        if (!good || good.physique === line.physique) continue;
        await target.query(
          'UPDATE stock_items SET quantity_on_hand = $1, version = version + 1, updated_at = now() WHERE id = $2',
          [good.physique, line.id],
        );
        await target.query(
          `INSERT INTO stock_movements (id, tenant_id, stock_item_id, type, quantity, created_at)
           VALUES (gen_random_uuid(), $1, $2, 'ADJUSTMENT', $3, now())`,
          [TENANT, line.id, good.physique - line.physique],
        );
        fixed++;
      }
      await target.query('COMMIT');
      console.log(`${fixed} lignes réparées depuis la copie restaurée.`);
      console.table(await levels(target));
    } catch (error) {
      await target.query('ROLLBACK');
      throw error;
    } finally {
      await source.end();
    }
  } else {
    console.error('mode : etat | casser | reparer');
    process.exitCode = 2;
  }
} finally {
  await target.end();
}
