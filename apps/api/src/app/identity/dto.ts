import { TenantRole } from '@stockpilot/database';
import { IsEmail, IsEnum, IsString, Length, MaxLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  /** 12 caractères au moins ; la longueur compte plus que la complexité imposée. */
  @IsString()
  @Length(12, 128)
  password!: string;

  @IsString()
  @Length(2, 100)
  companyName!: string;
}

export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @Length(1, 128)
  password!: string;
}

export class CreateTenantDto {
  @IsString()
  @Length(2, 100)
  name!: string;
}

export class InviteDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsEnum(TenantRole)
  role!: TenantRole;
}

export class AcceptInvitationDto {
  @IsString()
  @Length(20, 200)
  token!: string;
}

export class ChangeRoleDto {
  @IsEnum(TenantRole)
  role!: TenantRole;
}
