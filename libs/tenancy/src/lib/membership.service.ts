import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { recordAudit } from '@stockpilot/audit';
import {
  isRestrictViolation,
  TenantDatabase,
  TenantRole,
  type TenantTransaction,
} from '@stockpilot/database';
import {
  LastOwnerError,
  MemberNotFoundError,
  RoleChangeForbiddenError,
  TenantNotFoundError,
} from './errors.js';

export interface Actor {
  userId: string;
  role: TenantRole;
}

export interface MemberView {
  userId: string;
  email: string;
  role: TenantRole;
  since: Date;
}

export interface TenantView {
  tenantId: string;
  name: string;
  slug: string;
  role: TenantRole;
}

/**
 * Crée une entreprise et en fait de la personne son propriétaire, dans la transaction de l'appelant
 * (inscription, ou création d'une entreprise supplémentaire). Le contexte d'entreprise est posé ici : la
 * Row-Level Security exige qu'une ligne écrite appartienne à l'entreprise du contexte.
 */
export async function createTenantWithOwner(
  tx: TenantTransaction,
  userId: string,
  name: string,
): Promise<{ tenantId: string; slug: string }> {
  const tenantId = randomUUID();
  const slug = `${slugify(name)}-${tenantId.slice(0, 6)}`;
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
  await tx.tenant.create({ data: { id: tenantId, name, slug } });
  await tx.tenantMembership.create({
    data: { tenantId, userId, role: TenantRole.OWNER },
  });
  return { tenantId, slug };
}

@Injectable()
export class MembershipService {
  constructor(private readonly db: TenantDatabase) {}

  /**
   * Rôle de la personne dans l'entreprise, relu à chaque requête : un membre retiré perd l'accès tout de suite,
   * sans attendre l'expiration de son jeton. Pas membre (ou entreprise inexistante) : TenantNotFoundError.
   */
  async roleOf(userId: string, tenantId: string): Promise<TenantRole> {
    const membership = await this.db.runAs({ tenantId, userId }, (tx) =>
      tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
        select: { role: true },
      }),
    );
    if (!membership) throw new TenantNotFoundError();
    return membership.role;
  }

  /** Les entreprises de la personne : seul son contexte utilisateur est posé. */
  async tenantsOf(userId: string): Promise<TenantView[]> {
    const memberships = await this.db.runAs({ userId }, (tx) =>
      tx.tenantMembership.findMany({
        where: { userId },
        include: { tenant: { select: { name: true, slug: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return memberships.map((m) => ({
      tenantId: m.tenantId,
      name: m.tenant.name,
      slug: m.tenant.slug,
      role: m.role,
    }));
  }

  async createTenant(userId: string, name: string): Promise<TenantView> {
    const { tenantId, slug } = await this.db.runAs({ userId }, (tx) =>
      createTenantWithOwner(tx, userId, name),
    );
    return { tenantId, name, slug, role: TenantRole.OWNER };
  }

  async members(tenantId: string): Promise<MemberView[]> {
    const rows = await this.db.run(tenantId, (tx) =>
      tx.tenantMembership.findMany({
        include: { user: { select: { email: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      role: m.role,
      since: m.createdAt,
    }));
  }

  async changeRole(
    tenantId: string,
    actor: Actor,
    userId: string,
    role: TenantRole,
  ): Promise<MemberView> {
    return this.guarded(tenantId, async (tx) => {
      const target = await this.lockMember(tx, tenantId, userId);
      assertMayManage(actor, target.role, role);
      const updated = await tx.tenantMembership.update({
        where: { tenantId_userId: { tenantId, userId } },
        data: { role },
        include: { user: { select: { email: true } } },
      });
      await recordAudit(tx, {
        tenantId,
        actorId: actor.userId,
        action: 'member.role_changed',
        resourceType: 'member',
        resourceId: userId,
        details: { from: target.role, to: role },
      });
      return {
        userId,
        email: updated.user.email,
        role: updated.role,
        since: updated.createdAt,
      };
    });
  }

  async remove(tenantId: string, actor: Actor, userId: string): Promise<void> {
    await this.guarded(tenantId, async (tx) => {
      const target = await this.lockMember(tx, tenantId, userId);
      // Se retirer soi-même est permis (quitter l'entreprise), sauf au dernier propriétaire.
      if (userId !== actor.userId) assertMayManage(actor, target.role);
      await tx.tenantMembership.delete({
        where: { tenantId_userId: { tenantId, userId } },
      });
      await recordAudit(tx, {
        tenantId,
        actorId: actor.userId,
        action: userId === actor.userId ? 'member.left' : 'member.removed',
        resourceType: 'member',
        resourceId: userId,
        details: { role: target.role },
      });
    });
  }

  /** Le dernier propriétaire est protégé par un déclencheur de la base, vérifié au COMMIT. */
  private async guarded<T>(
    tenantId: string,
    work: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.run(tenantId, work);
    } catch (error) {
      if (isRestrictViolation(error)) throw new LastOwnerError();
      throw error;
    }
  }

  private async lockMember(
    tx: TenantTransaction,
    tenantId: string,
    userId: string,
  ) {
    const [row] = await tx.$queryRaw<{ role: TenantRole }[]>`
      SELECT role FROM tenant_memberships WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
    if (!row) throw new MemberNotFoundError();
    return row;
  }
}

/** Un administrateur gère les membres, mais ni les propriétaires ni la nomination d'un propriétaire. */
function assertMayManage(
  actor: Actor,
  targetRole: TenantRole,
  newRole?: TenantRole,
): void {
  if (actor.role === TenantRole.OWNER) return;
  if (targetRole === TenantRole.OWNER || newRole === TenantRole.OWNER) {
    throw new RoleChangeForbiddenError(
      'seul un propriétaire peut nommer ou modifier un propriétaire',
    );
  }
}

function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'entreprise'
  );
}
