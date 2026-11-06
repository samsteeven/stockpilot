import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthService, type Session } from '@stockpilot/identity';
import { MembershipService } from '@stockpilot/tenancy';
import type { Request, Response } from 'express';
import { CurrentUser, Public, UserScoped } from '../common/access';
import type { ApiConfig } from '../config';
import { API_CONFIG } from '../tokens';
import { CreateTenantDto, LoginDto, RegisterDto } from './dto';

export const REFRESH_COOKIE = 'stockpilot_refresh';
const REFRESH_PATH = '/api/v1/auth';

/**
 * Sessions. Le jeton d'accès est rendu dans la réponse (gardé en mémoire par le front) ; le jeton de
 * renouvellement part dans un cookie HttpOnly, SameSite=Strict, limité aux routes /api/v1/auth. Les routes qui
 * lisent ce cookie exigent l'en-tête X-Requested-With : un formulaire d'un autre site ne peut pas le poser.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly memberships: MembershipService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('register')
  async register(
    @Body() body: RegisterDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = await this.auth.register(
      body.email,
      body.password,
      body.companyName,
    );
    return { ...this.issue(session, response), tenantId: session.tenantId };
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.issue(
      await this.auth.login(body.email, body.password),
      response,
    );
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const token = this.refreshToken(request);
    try {
      return this.issue(await this.auth.refresh(token), response);
    } catch (error) {
      this.clearCookie(response);
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const token = request.cookies?.[REFRESH_COOKIE] as string | undefined;
    this.requireCsrfHeader(request);
    if (token) await this.auth.logout(token);
    this.clearCookie(response);
  }

  /** Le compte et ses entreprises, avec le rôle dans chacune. */
  @UserScoped()
  @Get('me')
  async me(@CurrentUser() userId: string) {
    const profile = await this.auth.profile(userId);
    if (!profile) throw new NotFoundException('Compte introuvable');
    return { ...profile, tenants: await this.memberships.tenantsOf(userId) };
  }

  @UserScoped()
  @Post('tenants')
  createTenant(@CurrentUser() userId: string, @Body() body: CreateTenantDto) {
    return this.memberships.createTenant(userId, body.name);
  }

  private issue(session: Session, response: Response) {
    response.cookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'strict',
      path: REFRESH_PATH,
      expires: session.refreshTokenExpiresAt,
    });
    return {
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      userId: session.userId,
    };
  }

  private clearCookie(response: Response): void {
    response.clearCookie(REFRESH_COOKIE, {
      path: REFRESH_PATH,
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'strict',
    });
  }

  private refreshToken(request: Request): string {
    this.requireCsrfHeader(request);
    const token = request.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!token) throw new UnauthorizedException('Session absente');
    return token;
  }

  private requireCsrfHeader(request: Request): void {
    if (request.header('x-requested-with') !== 'StockPilot') {
      throw new ForbiddenException('En-tête X-Requested-With manquant');
    }
  }
}
