import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  // M13: public, so it says nothing about the setup (environment, provider mode).
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @RateLimit('public')
  @Get()
  async check() {
    let database = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      time: new Date().toISOString(),
    };
  }
}
