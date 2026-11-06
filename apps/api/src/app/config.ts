/** Configuration de l'API, lue et vérifiée au démarrage : une variable manquante arrête le processus tout de suite. */
export interface ApiConfig {
  port: number;
  /** Rôle applicatif, soumis à la Row-Level Security. */
  appDatabaseUrl: string;
  databasePoolSize: number;
  redisUrl: string;
  reservationTtlSeconds: number;
  /** Secret HS256 des jetons d'accès, 32 caractères au moins. */
  jwtSecret: string;
  accessTokenMinutes: number;
  refreshTokenDays: number;
  /** Cookie de session en HTTPS seulement ; à désactiver uniquement en développement local (http). */
  cookieSecure: boolean;
  /** Tentatives d'inscription et de connexion par minute et par adresse IP. */
  authRateLimitPerMinute: number;
  /** Secret partagé avec le prestataire de paiement, 32 caractères au moins. */
  paymentWebhookSecret: string;
  /** Niveau des journaux (info par défaut ; warn dans les tests). */
  logLevel?: string;
  /** Port des métriques Prometheus (pas exposé au public) ; absent : pas de serveur de métriques. */
  metricsPort?: number;
  /** Proxys de confiance devant l'API (1 : un répartiteur ; 2 : CloudFront puis le répartiteur). */
  trustProxyHops?: number;
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    port: integer(env, 'PORT', 3000),
    appDatabaseUrl: required(env, 'APP_DATABASE_URL'),
    databasePoolSize: integer(env, 'DATABASE_POOL_SIZE', 10),
    redisUrl: required(env, 'REDIS_URL'),
    reservationTtlSeconds: integer(env, 'RESERVATION_TTL_SECONDS', 900),
    jwtSecret: required(env, 'JWT_SECRET'),
    accessTokenMinutes: integer(env, 'ACCESS_TOKEN_MINUTES', 15),
    refreshTokenDays: integer(env, 'REFRESH_TOKEN_DAYS', 14),
    cookieSecure: env['COOKIE_SECURE'] !== 'false',
    authRateLimitPerMinute: integer(env, 'AUTH_RATE_LIMIT_PER_MINUTE', 10),
    paymentWebhookSecret: required(env, 'PAYMENT_WEBHOOK_SECRET'),
    logLevel: env['LOG_LEVEL'] || 'info',
    metricsPort: env['METRICS_PORT']
      ? integer(env, 'METRICS_PORT', 9464)
      : undefined,
    trustProxyHops: integer(env, 'TRUST_PROXY_HOPS', 1),
  };
}

export function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Variable d'environnement ${name} manquante`);
  return value;
}

export function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} doit être un entier positif`);
  return value;
}
