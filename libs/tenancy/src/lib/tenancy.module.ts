import { Module } from '@nestjs/common';
import { InvitationService } from './invitation.service.js';
import { MembershipService } from './membership.service.js';

@Module({
  providers: [MembershipService, InvitationService],
  exports: [MembershipService, InvitationService],
})
export class TenancyModule {}
