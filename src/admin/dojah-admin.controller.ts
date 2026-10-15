import { Body, Controller, Get, HttpCode, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { AdminGuard } from './admin.guard';
import { RequirePermissions } from './require-permissions.decorator';
import { DojahReadinessService } from '../dojah/dojah-readiness.service';
import { DojahRecoveryService } from '../dojah/dojah-recovery.service';
import { DojahSettingsService } from './dojah-settings.service';
import { AdminService } from './admin.service';
import { CurrentAdmin } from './current-admin.decorator';
import type { AdminJwtPayload } from './admin.service';
import { DojahBasicSwitchDto, DojahSettingsDto, DojahThresholdsDto } from './dto';

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
    private readonly settings: DojahSettingsService,
    private readonly admin: AdminService,
  ) {}

  @Get('readiness')
  @RequirePermissions('settings.manage')
  report(@Query('refresh') refresh?: string) {
    return this.readiness.report(refresh === 'true');
  }

  /** The hard stop, warning level and tries, set from the Dojah screen. A null field goes back to the server default. */
  @Put('settings')
  @RequirePermissions('settings.manage')
  async saveSettings(@CurrentAdmin('sub') adminId: string, @Body() dto: DojahSettingsDto, @Req() req: Request) {
    const { before, after } = await this.settings.saveSettings(adminId, dto);
    await this.admin.audit(adminId, 'dojah.settings', 'SystemFlag', 'dojah_settings', before, after, req.ip);
    return this.readiness.report(true);
  }

  /** Basic verification on or off (null = server default). Owners only, with their password; "on" only when every check passes. */
  @Post('basic-switch')
  @HttpCode(200)
  @RequirePermissions('settings.manage')
  async basicSwitch(@CurrentAdmin() actor: AdminJwtPayload, @Body() dto: DojahBasicSwitchDto, @Req() req: Request) {
    const { before, after } = await this.settings.setBasicSwitch({ id: actor.sub, role: actor.role }, dto);
    await this.admin.audit(actor.sub, 'dojah.basic_switch', 'SystemFlag', 'dojah_settings', before, after, req.ip);
    return this.readiness.report(true);
  }

  /** The calculator: suggested hard stop and warning level from Dojah's prices. Saves nothing. */
  @Post('thresholds')
  @HttpCode(200)
  @RequirePermissions('settings.manage')
  suggest(@Body() dto: DojahThresholdsDto) {
    return this.settings.suggest(dto);
  }

  @Get('unknown-calls')
  @RequirePermissions('settings.manage')
  unknownCalls() {
    return this.recovery.unknownCalls();
  }
}
