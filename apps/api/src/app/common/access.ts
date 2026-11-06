import {
  BadRequestException,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TenantRole } from '@stockpilot/database';
import { AuthService } from '@stockpilot/identity';
import { can, MembershipService, type Permission } from '@stockpilot/tenancy';
import type { Request } from 'express';

/** Ce que le garde a établi pour la requête. */
export interface Access {
  userId: string;
  tenantId?: string;
  role?: TenantRole;
}

export interface TenantAccess {
  userId: string;
  tenantId: string;
  role: TenantRole;
}

type AccessRequest = Request & { access?: Access };

const PUBLIC = 'stockpilot:public';
const USER_SCOPED = 'stockpilot:user-scoped';
const PERMISSION = 'stockpilot:permission';

/** Route sans authentification (inscription, connexion, santé). */
export const Public = () => SetMetadata(PUBLIC, true);
/** Route d'un utilisateur authentifié, hors de toute entreprise (profil, création d'entreprise, invitation). */
export const UserScoped = () => SetMetadata(USER_SCOPED, true);
/** Permission exigée par une route d'entreprise. Une route d'entreprise sans permission déclarée est refusée. */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(PERMISSION, permission);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Garde global, dans cet ordre :
 * 1. jeton d'accès valide (sauf route publique) ;
 * 2. pour une route d'entreprise : X-Tenant-Id désigne l'entreprise choisie parmi celles de l'utilisateur, et
 *    l'adhésion est relue en base à chaque requête (un membre retiré perd l'accès tout de suite) ; pas membre :
 *    404, comme une entreprise inexistante ;
 * 3. la permission déclarée par la route est accordée par le rôle ; sinon 403.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly memberships: MembershipService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<AccessRequest>();
    const header = request.header('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Authentification requise');
    }
    const userId = this.auth.verifyAccessToken(token);

    if (this.reflector.getAllAndOverride<boolean>(USER_SCOPED, targets)) {
      request.access = { userId };
      return true;
    }

    const tenantId = request.header('x-tenant-id');
    if (!tenantId || !UUID.test(tenantId)) {
      throw new BadRequestException('En-tête X-Tenant-Id manquant ou invalide');
    }
    const role = await this.memberships.roleOf(userId, tenantId);
    const permission = this.reflector.getAllAndOverride<Permission>(
      PERMISSION,
      targets,
    );
    if (!permission || !can(role, permission)) {
      throw new ForbiddenException(
        `Rôle insuffisant${permission ? ` : ${permission} requis` : ''}`,
      );
    }
    request.access = { userId, tenantId, role };
    return true;
  }
}

/** L'accès d'une route d'entreprise (utilisateur, entreprise, rôle). */
export const CurrentAccess = createParamDecorator(
  (_: unknown, context: ExecutionContext): TenantAccess => {
    const access = context.switchToHttp().getRequest<AccessRequest>().access;
    if (!access?.tenantId || !access.role) {
      throw new UnauthorizedException('Accès non établi');
    }
    return access as TenantAccess;
  },
);

/** L'entreprise de la requête, établie par le garde. */
export const CurrentTenant = createParamDecorator(
  (_: unknown, context: ExecutionContext): string => {
    const tenantId = context.switchToHttp().getRequest<AccessRequest>()
      .access?.tenantId;
    if (!tenantId) throw new UnauthorizedException('Accès non établi');
    return tenantId;
  },
);

/** L'utilisateur authentifié. */
export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): string => {
    const userId = context.switchToHttp().getRequest<AccessRequest>()
      .access?.userId;
    if (!userId) throw new UnauthorizedException('Accès non établi');
    return userId;
  },
);
