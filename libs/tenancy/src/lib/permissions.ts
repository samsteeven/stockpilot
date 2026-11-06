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
  | 'members:manage'
  | 'orders:read'
  | 'orders:write'
  | 'audit:read';

const EVERYONE: Permission[] = ['stock:read', 'members:read', 'orders:read'];

export const ROLE_PERMISSIONS: Record<TenantRole, ReadonlySet<Permission>> = {
  OWNER: new Set<Permission>([
    ...EVERYONE,
    'stock:receive',
    'reservations:write',
    'catalog:write',
    'warehouses:write',
    'members:manage',
    'orders:write',
    'audit:read',
  ]),
  ADMIN: new Set<Permission>([
    ...EVERYONE,
    'stock:receive',
    'reservations:write',
    'catalog:write',
    'warehouses:write',
    'members:manage',
    'orders:write',
    'audit:read',
  ]),
  WAREHOUSE_MANAGER: new Set<Permission>([
    ...EVERYONE,
    'stock:receive',
    'reservations:write',
    'orders:write',
  ]),
  OPERATOR: new Set<Permission>([
    ...EVERYONE,
    'reservations:write',
    'orders:write',
  ]),
  VIEWER: new Set<Permission>(EVERYONE),
};

export function can(role: TenantRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
