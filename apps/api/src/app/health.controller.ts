import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '@stockpilot/database';
import { Public } from './common/access';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Vivant : le processus répond. */
  @Get()
  live() {
    return { status: 'ok' };
  }

  /** Prêt : la base répond (avant de recevoir du trafic). */
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('base de données injoignable');
    }
  }
}
