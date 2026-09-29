import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Public()
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
      quidax: this.config.get<boolean>('QUIDAX_USE_MOCK') ? 'mock' : 'live',
      env: this.config.get<string>('NODE_ENV'),
      time: new Date().toISOString(),
    };
  }
}
