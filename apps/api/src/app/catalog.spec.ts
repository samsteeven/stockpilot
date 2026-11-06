/** Catalogue et entrepôts : références uniques par entreprise, pagination par curseur, isolation. */
import type { INestApplication } from '@nestjs/common';
import { type Http, signUp, startApi } from './testing';

let app: INestApplication;
let http: Http;

beforeAll(async () => {
  ({ app, http } = await startApi());
});

afterAll(async () => {
  await app?.close();
});

const product = (sku: string, variants = [`${sku}-STD`]) => ({
  sku,
  name: `Produit ${sku}`,
  variants: variants.map((v) => ({ sku: v, name: v })),
});

it('un produit est créé avec ses variantes ; un SKU déjà pris dans l’entreprise : 409', async () => {
  const account = await signUp(http);

  const created = await http
    .post('/api/v1/products')
    .set(account.headers)
    .send(product('CASQUE', ['CASQUE-NOIR', 'CASQUE-BLANC']))
    .expect(201);
  await http
    .post('/api/v1/products')
    .set(account.headers)
    .send(product('CASQUE', ['AUTRE']))
    .expect(409);
  await http
    .post(`/api/v1/products/${created.body.id}/variants`)
    .set(account.headers)
    .send({ sku: 'CASQUE-NOIR', name: 'Doublon' })
    .expect(409);
  await http
    .post('/api/v1/products')
    .set(account.headers)
    .send(product('CABLE', ['CABLE-1M', 'CABLE-1M']))
    .expect(409);

  expect(created.body.variants.map((v: { sku: string }) => v.sku)).toEqual([
    'CASQUE-BLANC',
    'CASQUE-NOIR',
  ]);
  const list = await http
    .get('/api/v1/products')
    .set(account.headers)
    .expect(200);
  expect(list.body.items.map((p: { sku: string }) => p.sku)).toEqual([
    'CASQUE',
  ]); // le produit refusé n'a laissé aucune trace
});

it('deux entreprises peuvent utiliser le même SKU sans se voir', async () => {
  const a = await signUp(http);
  const b = await signUp(http);

  await http
    .post('/api/v1/products')
    .set(a.headers)
    .send(product('SKU-COMMUN'))
    .expect(201);
  await http
    .post('/api/v1/products')
    .set(b.headers)
    .send(product('SKU-COMMUN'))
    .expect(201);
  const created = await http
    .post('/api/v1/products')
    .set(a.headers)
    .send(product('SEULEMENT-A'))
    .expect(201);

  const listB = await http.get('/api/v1/products').set(b.headers).expect(200);
  expect(listB.body.items.map((p: { sku: string }) => p.sku)).toEqual([
    'SKU-COMMUN',
  ]);
  await http
    .post(`/api/v1/products/${created.body.id}/variants`)
    .set(b.headers)
    .send({ sku: 'INTRUS', name: 'x' })
    .expect(404);
});

it('la pagination par curseur parcourt tout, sans doublon ni oubli', async () => {
  const account = await signUp(http);
  for (let i = 1; i <= 7; i++) {
    await http
      .post('/api/v1/products')
      .set(account.headers)
      .send(product(`P${i}`))
      .expect(201);
  }

  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await http
      .get('/api/v1/products')
      .query({ limit: 3, ...(cursor ? { cursor } : {}) })
      .set(account.headers)
      .expect(200);
    seen.push(...page.body.items.map((p: { sku: string }) => p.sku));
    cursor = page.body.nextCursor;
  } while (cursor);

  expect(seen).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']);
});

it('recherche par SKU ou nom, sans tenir compte de la casse', async () => {
  const account = await signUp(http);
  await http
    .post('/api/v1/products')
    .set(account.headers)
    .send(product('CASQUE-ANC'))
    .expect(201);
  await http
    .post('/api/v1/products')
    .set(account.headers)
    .send(product('CABLE-USBC'))
    .expect(201);

  const found = await http
    .get('/api/v1/products')
    .query({ search: 'casque' })
    .set(account.headers)
    .expect(200);

  expect(found.body.items.map((p: { sku: string }) => p.sku)).toEqual([
    'CASQUE-ANC',
  ]);
});

it('entrepôts : code normalisé en majuscules et unique par entreprise', async () => {
  const account = await signUp(http);

  const paris = await http
    .post('/api/v1/warehouses')
    .set(account.headers)
    .send({ code: 'par', name: 'Paris' })
    .expect(201);
  await http
    .post('/api/v1/warehouses')
    .set(account.headers)
    .send({ code: 'PAR', name: 'Paris bis' })
    .expect(409);

  expect(paris.body.code).toBe('PAR');
});

it('entrée invalide (SKU avec espaces, limite hors bornes) : 400', async () => {
  const account = await signUp(http);

  await http
    .post('/api/v1/products')
    .set(account.headers)
    .send(product('SKU AVEC ESPACE'))
    .expect(400);
  await http
    .get('/api/v1/products')
    .query({ limit: 1000 })
    .set(account.headers)
    .expect(400);
});
