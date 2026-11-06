/**
 * Journaux d'une vraie requête HTTP passée par pino-http avec la configuration de StockPilot : identifiant de
 * corrélation, entreprise et utilisateur, et surtout rien de secret.
 */
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
} from 'node:http';
import { Writable } from 'node:stream';
import { type Options, pinoHttp } from 'pino-http';
import { loggingParams } from './logging.js';

let server: Server;
let port: number;
const lines: Record<string, unknown>[] = [];

beforeAll(async () => {
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean))
        lines.push(JSON.parse(line));
      done();
    },
  });
  const options = loggingParams({ service: 'api' }).pinoHttp as Options;
  // Même configuration qu'en production, écrite dans un flux lu par le test.
  const middleware = pinoHttp(options, sink);
  server = createServer((req, res) => {
    middleware(req, res);
    // Ce que le garde d'accès pose sur la requête.
    (req as IncomingMessage & { access?: unknown }).access = {
      tenantId: 't-1',
      userId: 'u-1',
    };
    res.statusCode = req.url?.startsWith('/inconnu') ? 404 : 200;
    res.setHeader(
      'Set-Cookie',
      'stockpilot_refresh=secret-du-cookie; HttpOnly',
    );
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function call(path: string, headers: Record<string, string>) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers }, resolve)
      .on('error', reject)
      .end();
  });
}

const secrets = {
  authorization: 'Bearer eyJ.jeton.secret',
  cookie: 'stockpilot_refresh=autre-secret',
  'stockpilot-signature': 't=1,v1=signature-secrete',
};

it('masque jeton, cookies et signature ; garde la route sans paramètres', async () => {
  lines.length = 0;
  const response = await call(
    '/api/v1/products?search=client@example.com',
    secrets,
  );
  response.resume();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const text = JSON.stringify(lines);
  for (const secret of [
    'eyJ.jeton.secret',
    'autre-secret',
    'signature-secrete',
    'secret-du-cookie',
  ])
    expect(text).not.toContain(secret);
  expect(text).not.toContain('client@example.com');
  const entry = lines.find((l) => l['msg'] === 'request completed') as {
    req: { path: string; id: string };
    tenantId: string;
    userId: string;
    service: string;
  };
  expect(entry).toMatchObject({
    service: 'api',
    tenantId: 't-1',
    userId: 'u-1',
    req: { path: '/api/v1/products' },
  });
  expect(response.headers['x-request-id']).toBe(entry.req.id);
});

it('reprend un identifiant de corrélation valide, remplace un identifiant douteux', async () => {
  const kept = await call('/a', { 'x-request-id': 'alb-1234567890' });
  kept.resume();
  expect(kept.headers['x-request-id']).toBe('alb-1234567890');
  const replaced = await call('/a', {
    'x-request-id': '<script>alert(1)</script>',
  });
  replaced.resume();
  expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
});

it('niveau warn pour une erreur client', async () => {
  lines.length = 0;
  const response = await call('/inconnu', {});
  response.resume();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(lines.find((l) => l['msg'] === 'request completed')?.['level']).toBe(
    40,
  );
});
