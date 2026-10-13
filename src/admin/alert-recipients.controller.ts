import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { AlertRecipientsService } from '../common/ops-alerts/alert-recipients.service';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
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
  constructor(
    private readonly recipients: AlertRecipientsService,
    private readonly admin: AdminService,
  ) {}

  @Get()
  @RequirePermissions('alerts.manage')
  list() {
    return this.recipients.list();
  }

  @Post()
  @RequirePermissions('alerts.manage')
  async add(@CurrentAdmin('sub') adminId: string, @Body() dto: AddAlertRecipientDto, @Req() req: Request) {
    const row = await this.recipients.add(dto.type, dto.email);
    await this.admin.audit(adminId, 'alert_recipient.add', 'AlertRecipient', row.id, null, row, req.ip);
    return row;
  }

  @Patch(':id')
  @RequirePermissions('alerts.manage')
  async setEnabled(
    @CurrentAdmin('sub') adminId: string,
    @Param('id') id: string,
    @Body() dto: SetAlertRecipientEnabledDto,
    @Req() req: Request,
  ) {
    const { before, after } = await this.recipients.setEnabled(id, dto.enabled);
    await this.admin.audit(
      adminId,
      dto.enabled ? 'alert_recipient.enable' : 'alert_recipient.disable',
      'AlertRecipient',
      id,
      before,
      after,
      req.ip,
    );
    return after;
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('alerts.manage')
  async remove(@CurrentAdmin('sub') adminId: string, @Param('id') id: string, @Req() req: Request): Promise<void> {
    const removed = await this.recipients.remove(id);
    await this.admin.audit(adminId, 'alert_recipient.remove', 'AlertRecipient', id, removed, null, req.ip);
  }
}
