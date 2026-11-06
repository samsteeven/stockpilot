import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';

/** En-tête de corrélation : repris s'il est fourni (répartiteur de charge, front), créé sinon, renvoyé au client. */
export const REQUEST_ID_HEADER = 'x-request-id';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Ce qui ne doit jamais apparaître dans un journal : jetons, cookies de session, signature du prestataire, mots
 * de passe. pino remplace ces champs avant l'écriture.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["stockpilot-signature"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.refreshToken',
  '*.accessToken',
  '*.token',
];

type AccessRequest = IncomingMessage & {
  id?: string;
  access?: { userId?: string; tenantId?: string };
  route?: { path?: string };
};

export interface LoggingOptions {
  /** Nom du processus dans chaque ligne (api, worker). */
  service: string;
  level?: string;
}

/**
 * Journaux JSON, une ligne par événement : lisibles par CloudWatch, Loki ou `jq`. Chaque requête HTTP porte un
 * identifiant de corrélation, l'entreprise et l'utilisateur établis par le garde, la route (pas l'URL brute,
 * qui contiendrait des identifiants) et sa durée.
 */
export function loggingParams(options: LoggingOptions): Params {
  return {
    pinoHttp: {
      level: options.level ?? 'info',
      base: { service: options.service },
      redact: { paths: REDACTED_PATHS, censor: '[masqué]' },
      genReqId(req: IncomingMessage, res: ServerResponse) {
        const incoming = req.headers[REQUEST_ID_HEADER];
        const id =
          typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming)
            ? incoming
            : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customProps(req: IncomingMessage) {
        const r = req as AccessRequest;
        return {
          ...(r.access?.tenantId ? { tenantId: r.access.tenantId } : {}),
          ...(r.access?.userId ? { userId: r.access.userId } : {}),
        };
      },
      customLogLevel(_req, res, error) {
        if (error || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      serializers: {
        req(req: { id: string; method: string; url: string }) {
          // L'URL sans paramètres : un e-mail ou une recherche ne finit pas dans les journaux.
          return {
            id: req.id,
            method: req.method,
            path: req.url.split('?')[0],
          };
        },
        res(res: { statusCode: number }) {
          return { statusCode: res.statusCode };
        },
      },
      autoLogging: {
        ignore: (req: IncomingMessage) => (req.url ?? '').startsWith('/health'),
      },
    },
  };
}
