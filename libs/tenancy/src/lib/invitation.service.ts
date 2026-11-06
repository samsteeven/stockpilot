import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  isUniqueViolation,
  PrismaService,
  TenantDatabase,
  TenantRole,
} from '@stockpilot/database';
import {
  AlreadyMemberError,
  InvitationEmailMismatchError,
  InvitationInvalidError,
  RoleChangeForbiddenError,
} from './errors.js';
import type { Actor } from './membership.service.js';

const INVITATION_TTL_MS = 7 * 24 * 3600 * 1000;

export interface CreatedInvitation {
  invitationId: string;
  email: string;
  role: TenantRole;
  expiresAt: Date;
  /** Montré une seule fois, à l'administrateur qui invite (pas d'e-mail pour l'instant) ; seule son empreinte est gardée. */
  token: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class InvitationService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly prisma: PrismaService,
  ) {}

  async invite(
    tenantId: string,
    actor: Actor,
    email: string,
    role: TenantRole,
  ): Promise<CreatedInvitation> {
    if (role === TenantRole.OWNER && actor.role !== TenantRole.OWNER) {
      throw new RoleChangeForbiddenError(
        'seul un propriétaire peut inviter un propriétaire',
      );
    }
    const token = randomBytes(32).toString('base64url');
    const normalized = email.trim().toLowerCase();
    const invitation = await this.db.run(tenantId, (tx) =>
      tx.invitation.create({
        data: {
          tenantId,
          email: normalized,
          role,
          tokenHash: hashToken(token),
          invitedBy: actor.userId,
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        },
      }),
    );
    return {
      invitationId: invitation.id,
      email: normalized,
      role,
      expiresAt: invitation.expiresAt,
      token,
    };
  }

  /**
   * Accepter : l'invitation est retrouvée par l'empreinte du jeton (fonction SQL qui ne révèle qu'elle), puis
   * consommée dans le contexte de son entreprise. Usage unique : la mise à jour conditionnelle sur accepted_at
   * ne réussit qu'une fois, même si le lien est ouvert deux fois en même temps.
   */
  async accept(
    userId: string,
    userEmail: string,
    token: string,
  ): Promise<{ tenantId: string; role: TenantRole }> {
    const [found] = await this.prisma.$queryRaw<
      {
        id: string;
        tenant_id: string;
        email: string;
        role: TenantRole;
        expires_at: Date;
        accepted_at: Date | null;
      }[]
    >`SELECT * FROM invitation_by_token_hash(${hashToken(token)})`;
    if (!found) throw new InvitationInvalidError('unknown');
    if (found.accepted_at) throw new InvitationInvalidError('used');
    if (found.expires_at.getTime() <= Date.now())
      throw new InvitationInvalidError('expired');
    if (found.email !== userEmail.toLowerCase())
      throw new InvitationEmailMismatchError();

    try {
      return await this.db.runAs(
        { tenantId: found.tenant_id, userId },
        async (tx) => {
          const consumed = await tx.$executeRaw`
          UPDATE invitations SET accepted_at = now()
          WHERE id = ${found.id}::uuid AND accepted_at IS NULL AND expires_at > now()`;
          if (consumed === 0) throw new InvitationInvalidError('used');
          await tx.tenantMembership.create({
            data: { tenantId: found.tenant_id, userId, role: found.role },
          });
          return { tenantId: found.tenant_id, role: found.role };
        },
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new AlreadyMemberError();
      throw error;
    }
  }
}
