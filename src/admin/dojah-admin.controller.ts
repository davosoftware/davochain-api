import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { AdminGuard } from './admin.guard';
import { RequirePermissions } from './require-permissions.decorator';
import { DojahReadinessService } from '../dojah/dojah-readiness.service';
import { DojahRecoveryService } from '../dojah/dojah-recovery.service';

/** Whether Basic can run, and the calls to reconcile against Dojah's bill (spec §12.2, §14.5). */
@Public() // opts out of the USER guard; AdminGuard takes over
@UseGuards(AdminGuard)
@RateLimit('default')
@ApiTags('admin')
@ApiBearerAuth('admin')
@Controller('admin/dojah')
export class DojahAdminController {
  constructor(
    private readonly readiness: DojahReadinessService,
    private readonly recovery: DojahRecoveryService,
  ) {}

  @Get('readiness')
  @RequirePermissions('settings.manage')
  report(@Query('refresh') refresh?: string) {
    return this.readiness.report(refresh === 'true');
  }

  @Get('unknown-calls')
  @RequirePermissions('settings.manage')
  unknownCalls() {
    return this.recovery.unknownCalls();
  }
}
