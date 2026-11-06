/**
 * Données de démonstration : l'entreprise « Atelier Nova », trois entrepôts (Paris, Lyon, Bordeaux), quelques
 * articles et leur stock. Identifiants fixes : la démonstration se rejoue avec les mêmes valeurs.
 *
 *   DATABASE_URL=postgresql://stockpilot:stockpilot@127.0.0.1:5437/stockpilot npm run db:seed
 *
 * Écrit avec le rôle propriétaire (les migrations), hors Row-Level Security. Rejouable : rien n'est dupliqué.
 */
import * as argon2 from 'argon2';
import pg from 'pg';

const TENANT = '0a1e5c3e-5b7a-4c1e-9f00-000000000001';
const OWNER = {
  id: '0a1e5c3e-5b7a-4c1e-9f00-0000000000d1',
  email: 'demo@atelier-nova.example',
  // Compte de démonstration local : mot de passe public, jamais à utiliser hors d'un poste ou d'une CI.
  password: 'demonstration-stockpilot',
};
const WAREHOUSES = {
  PAR: { id: '0a1e5c3e-5b7a-4c1e-9f00-0000000000a1', name: 'Paris' },
  LYO: { id: '0a1e5c3e-5b7a-4c1e-9f00-0000000000a2', name: 'Lyon' },
  BDX: { id: '0a1e5c3e-5b7a-4c1e-9f00-0000000000a3', name: 'Bordeaux' },
};
const PRODUCTS = [
  {
    id: '0a1e5c3e-5b7a-4c1e-9f00-0000000000b1',
    sku: 'CASQUE-ANC',
    name: 'Casque à réduction de bruit',
    variants: [
      {
        id: '0a1e5c3e-5b7a-4c1e-9f00-0000000000c1',
        sku: 'CASQUE-ANC-NOIR',
        name: 'Noir',
        price: '129.90',
        stock: { PAR: 5, LYO: 12, BDX: 0 },
      },
      {
        id: '0a1e5c3e-5b7a-4c1e-9f00-0000000000c2',
        sku: 'CASQUE-ANC-BLANC',
        name: 'Blanc',
        price: '129.90',
        stock: { PAR: 2, LYO: 0, BDX: 7 },
      },
    ],
  },
  {
    id: '0a1e5c3e-5b7a-4c1e-9f00-0000000000b2',
    sku: 'CABLE-USBC',
    name: 'Câble USB-C 2 m',
    variants: [
      {
        id: '0a1e5c3e-5b7a-4c1e-9f00-0000000000c3',
        sku: 'CABLE-USBC-2M',
        name: '2 m',
        price: '12.50',
        stock: { PAR: 140, LYO: 80, BDX: 60 },
      },
    ],
  },
];

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL manquante (rôle propriétaire)');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Atelier Nova', 'atelier-nova') ON CONFLICT (id) DO NOTHING`,
      [TENANT],
    );
    await client.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [
        OWNER.id,
        OWNER.email,
        await argon2.hash(OWNER.password, { type: argon2.argon2id }),
      ],
    );
    await client.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'OWNER') ON CONFLICT DO NOTHING`,
      [TENANT, OWNER.id],
    );
    for (const [code, warehouse] of Object.entries(WAREHOUSES)) {
      await client.query(
        'INSERT INTO warehouses (id, tenant_id, code, name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
        [warehouse.id, TENANT, code, warehouse.name],
      );
    }
    for (const product of PRODUCTS) {
      await client.query(
        'INSERT INTO products (id, tenant_id, sku, name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
        [product.id, TENANT, product.sku, product.name],
      );
      for (const variant of product.variants) {
        await client.query(
          `INSERT INTO product_variants (id, tenant_id, product_id, sku, name, unit_price, currency)
           VALUES ($1, $2, $3, $4, $5, $6, 'EUR')
           ON CONFLICT (id) DO UPDATE SET unit_price = EXCLUDED.unit_price`,
          [
            variant.id,
            TENANT,
            product.id,
            variant.sku,
            variant.name,
            variant.price,
          ],
        );
        for (const [code, quantity] of Object.entries(variant.stock)) {
          const warehouseId = WAREHOUSES[code as keyof typeof WAREHOUSES].id;
          const inserted = await client.query(
            `INSERT INTO stock_items (id, tenant_id, warehouse_id, variant_id, quantity_on_hand, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, now())
             ON CONFLICT (tenant_id, warehouse_id, variant_id) DO NOTHING RETURNING id`,
            [TENANT, warehouseId, variant.id, quantity],
          );
          if (inserted.rowCount && quantity > 0) {
            await client.query(
              `INSERT INTO stock_movements (id, tenant_id, stock_item_id, type, quantity, created_at)
               VALUES (gen_random_uuid(), $1, $2, 'RECEIPT', $3, now())`,
              [TENANT, inserted.rows[0].id, quantity],
            );
          }
        }
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
  console.log(
    `Atelier Nova prête : ${OWNER.email} / ${OWNER.password} (propriétaire), X-Tenant-Id: ${TENANT}`,
  );
  console.log(
    `Entrepôt de Paris : ${WAREHOUSES.PAR.id} ; casque noir : ${PRODUCTS[0].variants[0].id} (5 en stock)`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
