import { TenantRole } from '@stockpilot/database';

/**
 * Permissions de l'application. Une route en exige une ; un rôle en accorde plusieurs. Les règles métier
 * (un administrateur ne touche pas aux propriétaires…) sont vérifiées en plus, dans les services.
 */
export type Permission =
  | 'stock:read'
  | 'stock:receive'
  | 'reservations:write'
  | 'catalog:write'
  | 'warehouses:write'
  | 'members:read'
  | 'members:manage';

const EVERYONE: Permission[] = ['stock:read', 'members:read'];

export const ROLE_PERMISSIONS: Record<TenantRole, ReadonlySet<Permission>> = {
  OWNER: new Set<Permission>([
    ...EVERYONE,
    'stock:receive',
    'reservations:write',
    'catalog:write',
    'warehouses:write',
    'members:manage',
  ]),
  ADMIN: new Set<Permission>([
    ...EVERYONE,
    'stock:receive',
    'reservations:write',
    'catalog:write',
    'warehouses:write',
    'members:manage',
  ]),
  WAREHOUSE_MANAGER: new Set<Permission>([
    ...EVERYONE,
    'stock:receive',
    'reservations:write',
  ]),
  OPERATOR: new Set<Permission>([...EVERYONE, 'reservations:write']),
  VIEWER: new Set<Permission>(EVERYONE),
};

export function can(role: TenantRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
