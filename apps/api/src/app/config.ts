/** Configuration de l'API, lue et vérifiée au démarrage : une variable manquante arrête le processus tout de suite. */
export interface ApiConfig {
  port: number;
  /** Rôle applicatif, soumis à la Row-Level Security. */
  appDatabaseUrl: string;
  databasePoolSize: number;
  redisUrl: string;
  reservationTtlSeconds: number;
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    port: integer(env, 'PORT', 3000),
    appDatabaseUrl: required(env, 'APP_DATABASE_URL'),
    databasePoolSize: integer(env, 'DATABASE_POOL_SIZE', 10),
    redisUrl: required(env, 'REDIS_URL'),
    reservationTtlSeconds: integer(env, 'RESERVATION_TTL_SECONDS', 900),
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
