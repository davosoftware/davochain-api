import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { AlertRecipientsService } from '../common/ops-alerts/alert-recipients.service';
import { AdminGuard } from './admin.guard';
import { CurrentAdmin } from './current-admin.decorator';
import { RequirePermissions } from './require-permissions.decorator';
import { AddAlertRecipientDto, SetAlertRecipientEnabledDto } from './dto';

/**
 * Who receives operational alerts (spec §3.3). Every change is audited, and
 * a security alert can never be left with nobody to tell.
 */
@Public() // opts out of the USER guard; AdminGuard takes over
@UseGuards(AdminGuard)
@RateLimit('default')
@ApiTags('admin')
@ApiBearerAuth('admin')
@Controller('admin/alert-recipients')
export class AlertRecipientsController {
  constructor(private readonly recipients: AlertRecipientsService) {}

  @Get()
  @RequirePermissions('alerts.manage')
  list() {
    return this.recipients.list();
  }

  @Post()
  @RequirePermissions('alerts.manage')
  async add(@CurrentAdmin('sub') adminId: string, @Body() dto: AddAlertRecipientDto, @Req() req: Request) {
    // Audited inside the same transaction as the change (final review m3).
    return this.recipients.add(dto.type, dto.email, { adminId, ip: req.ip });
  }

  @Patch(':id')
  @RequirePermissions('alerts.manage')
  async setEnabled(
    @CurrentAdmin('sub') adminId: string,
    @Param('id') id: string,
    @Body() dto: SetAlertRecipientEnabledDto,
    @Req() req: Request,
  ) {
    const { after } = await this.recipients.setEnabled(id, dto.enabled, { adminId, ip: req.ip });
    return after;
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('alerts.manage')
  async remove(@CurrentAdmin('sub') adminId: string, @Param('id') id: string, @Req() req: Request): Promise<void> {
    await this.recipients.remove(id, { adminId, ip: req.ip });
  }
}
