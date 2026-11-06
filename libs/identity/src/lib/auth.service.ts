import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  isUniqueViolation,
  PrismaService,
  TenantDatabase,
} from '@stockpilot/database';
import { createTenantWithOwner, hashToken } from '@stockpilot/tenancy';
import {
  EmailTakenError,
  InvalidAccessTokenError,
  InvalidCredentialsError,
  InvalidSessionError,
} from './errors.js';
import { PasswordHasher } from './passwords.js';

export interface IdentityOptions {
  /** Secret HS256 des jetons d'accès (32 caractères au moins) : l'API est seule à les émettre et à les vérifier. */
  jwtSecret: string;
  accessTokenMinutes: number;
  refreshTokenDays: number;
}

export const IDENTITY_OPTIONS = Symbol('IDENTITY_OPTIONS');

export interface Session {
  accessToken: string;
  accessTokenExpiresAt: Date;
  /** À poser dans un cookie HttpOnly : jamais lisible par le JavaScript de la page. */
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  userId: string;
}

export interface Registration extends Session {
  tenantId: string;
}

/**
 * Comptes et sessions.
 *
 * - Jeton d'accès JWT court (15 min), qui ne dit que « qui » : l'entreprise et le rôle sont relus en base à chaque
 *   requête.
 * - Jeton de renouvellement opaque, stocké sous forme d'empreinte, remplacé à chaque usage. Un jeton déjà échangé
 *   et présenté de nouveau signale un vol : toute la famille (la session) est révoquée.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly db: TenantDatabase,
    private readonly passwords: PasswordHasher,
    private readonly jwt: JwtService,
    @Inject(IDENTITY_OPTIONS) private readonly options: IdentityOptions,
  ) {}

  /** Inscription : le compte, son entreprise et son adhésion de propriétaire, tout ou rien. */
  async register(
    email: string,
    password: string,
    companyName: string,
  ): Promise<Registration> {
    const normalized = normalize(email);
    const passwordHash = await this.passwords.hash(password);
    const userId = randomUUID();
    try {
      const tenantId = await this.db.runAs({ userId }, async (tx) => {
        await tx.user.create({
          data: { id: userId, email: normalized, passwordHash },
        });
        const { tenantId } = await createTenantWithOwner(
          tx,
          userId,
          companyName,
        );
        return tenantId;
      });
      return { ...(await this.openSession(userId, randomUUID())), tenantId };
    } catch (error) {
      if (isUniqueViolation(error)) throw new EmailTakenError();
      throw error;
    }
  }

  async login(email: string, password: string): Promise<Session> {
    const user = await this.prisma.user.findUnique({
      where: { email: normalize(email) },
      select: { id: true, passwordHash: true },
    });
    const valid = await this.passwords.verify(
      user?.passwordHash ?? null,
      password,
    );
    if (!user || !valid) throw new InvalidCredentialsError();
    return this.openSession(user.id, randomUUID());
  }

  /** Échange un jeton de renouvellement contre une nouvelle paire ; l'ancien ne vaut plus rien. */
  async refresh(refreshToken: string): Promise<Session> {
    const hash = hashToken(refreshToken);
    const outcome = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<
        {
          id: string;
          user_id: string;
          family_id: string;
          expires_at: Date;
          used_at: Date | null;
          revoked_at: Date | null;
        }[]
      >`SELECT id, user_id, family_id, expires_at, used_at, revoked_at FROM refresh_tokens
        WHERE token_hash = ${hash} FOR UPDATE`;
      if (!row) return { error: 'unknown' as const };
      if (row.revoked_at) return { error: 'revoked' as const };
      if (row.used_at) {
        // Rejeu d'un jeton déjà échangé : quelqu'un d'autre l'a peut-être volé. Toute la session tombe.
        await tx.refreshToken.updateMany({
          where: { familyId: row.family_id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return { error: 'replayed' as const };
      }
      if (row.expires_at.getTime() <= Date.now())
        return { error: 'expired' as const };
      await tx.refreshToken.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      });
      return { userId: row.user_id, familyId: row.family_id };
    });
    if (!('userId' in outcome) || !outcome.userId || !outcome.familyId) {
      throw new InvalidSessionError(outcome.error ?? 'unknown');
    }
    return this.openSession(outcome.userId, outcome.familyId);
  }

  /** Déconnexion : la session entière (la famille du jeton) est révoquée. */
  async logout(refreshToken: string): Promise<void> {
    const token = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
      select: { familyId: true },
    });
    if (!token) return;
    await this.prisma.refreshToken.updateMany({
      where: { familyId: token.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  verifyAccessToken(token: string): string {
    try {
      const payload = this.jwt.verify<{ sub: string; typ: string }>(token, {
        algorithms: ['HS256'],
      });
      if (payload.typ !== 'access' || typeof payload.sub !== 'string')
        throw new Error();
      return payload.sub;
    } catch {
      throw new InvalidAccessTokenError();
    }
  }

  async profile(
    userId: string,
  ): Promise<{ userId: string; email: string } | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    return user ? { userId: user.id, email: user.email } : null;
  }

  private async openSession(
    userId: string,
    familyId: string,
  ): Promise<Session> {
    const now = Date.now();
    const accessTokenExpiresAt = new Date(
      now + this.options.accessTokenMinutes * 60_000,
    );
    const accessToken = await this.jwt.signAsync(
      { sub: userId, typ: 'access' },
      {
        algorithm: 'HS256',
        expiresIn: this.options.accessTokenMinutes * 60,
        jwtid: randomUUID(),
      },
    );
    const refreshToken = randomBytes(32).toString('base64url');
    const refreshTokenExpiresAt = new Date(
      now + this.options.refreshTokenDays * 86_400_000,
    );
    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: hashToken(refreshToken),
        expiresAt: refreshTokenExpiresAt,
      },
    });
    return {
      accessToken,
      accessTokenExpiresAt,
      refreshToken,
      refreshTokenExpiresAt,
      userId,
    };
  }
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}
