/** Codes d'erreur PostgreSQL et Prisma utiles au domaine, sans dépendre du détail du pilote. */

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

function codes(error: unknown): string[] {
  const found: string[] = [];
  let current: unknown = error;
  for (
    let depth = 0;
    current && typeof current === 'object' && depth < 5;
    depth++
  ) {
    const record = current as Record<string, unknown>;
    for (const key of ['code', 'originalCode']) {
      if (typeof record[key] === 'string') found.push(record[key] as string);
    }
    const meta = record['meta'] as Record<string, unknown> | undefined;
    const driver = meta?.['driverAdapterError'] as
      Record<string, unknown> | undefined;
    const cause = driver?.['cause'] as Record<string, unknown> | undefined;
    if (typeof cause?.['originalCode'] === 'string')
      found.push(cause['originalCode'] as string);
    if (typeof cause?.['kind'] === 'string')
      found.push(cause['kind'] as string);
    current = record['cause'];
  }
  return found;
}

/** Contrainte d'unicité violée (P2002 côté Prisma, 23505 côté PostgreSQL). */
export function isUniqueViolation(error: unknown): boolean {
  const all = codes(error);
  return (
    all.includes('P2002') ||
    all.includes(UNIQUE_VIOLATION) ||
    all.includes('UniqueConstraintViolation')
  );
}

/** Contrainte CHECK violée (23514). */
export function isCheckViolation(error: unknown): boolean {
  return codes(error).includes(CHECK_VIOLATION);
}
