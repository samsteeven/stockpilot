import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { AuthService } from '@stockpilot/identity';
import { can, InvitationService, MembershipService } from '@stockpilot/tenancy';
import {
  CurrentAccess,
  CurrentUser,
  RequirePermission,
  type TenantAccess,
  UserScoped,
} from '../common/access';
import { AcceptInvitationDto, ChangeRoleDto, InviteDto } from './dto';

@Controller('members')
export class MembersController {
  constructor(private readonly memberships: MembershipService) {}

  @RequirePermission('members:read')
  @Get()
  list(@CurrentAccess() access: TenantAccess) {
    return this.memberships.members(access.tenantId);
  }

  @RequirePermission('members:manage')
  @Patch(':userId')
  changeRole(
    @CurrentAccess() access: TenantAccess,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: ChangeRoleDto,
  ) {
    return this.memberships.changeRole(
      access.tenantId,
      access,
      userId,
      body.role,
    );
  }

  /** Retirer un membre ; tout membre peut se retirer lui-même (quitter l'entreprise). */
  @RequirePermission('members:read')
  @Delete(':userId')
  @HttpCode(204)
  async remove(
    @CurrentAccess() access: TenantAccess,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    // Sans le droit de gérer les membres, on ne peut retirer que soi-même.
    if (userId !== access.userId && !can(access.role, 'members:manage')) {
      throw new ForbiddenException('Rôle insuffisant : members:manage requis');
    }
    await this.memberships.remove(access.tenantId, access, userId);
  }
}

@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationService,
    private readonly auth: AuthService,
  ) {}

  /** Le jeton n'est montré qu'ici, une fois : à transmettre à la personne invitée (pas d'e-mail pour l'instant). */
  @RequirePermission('members:manage')
  @Post()
  invite(@CurrentAccess() access: TenantAccess, @Body() body: InviteDto) {
    return this.invitations.invite(
      access.tenantId,
      access,
      body.email,
      body.role,
    );
  }

  @UserScoped()
  @Post('accept')
  @HttpCode(200)
  async accept(
    @CurrentUser() userId: string,
    @Body() body: AcceptInvitationDto,
  ) {
    const profile = await this.auth.profile(userId);
    if (!profile) throw new NotFoundException('Compte introuvable');
    return this.invitations.accept(userId, profile.email, body.token);
  }
}
