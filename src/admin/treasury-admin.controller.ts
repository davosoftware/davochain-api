import { Body, Controller, Get, HttpCode, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { AdminGuard } from './admin.guard';
import { RequirePermissions } from './require-permissions.decorator';
import { CurrentAdmin } from './current-admin.decorator';
import { AdminService, type AdminJwtPayload } from './admin.service';
import { TreasuryService } from '../treasury/treasury.service';
import { TreasuryCheckNameDto, TreasuryMoveDto, TreasuryPasswordDto, TreasurySettingsDto } from './dto';

/**
 * Treasury (decision 16–19 Oct): our naira at the naira rail and at Quidax
 * against what customers are owed; owners set the payout reserve and the Quidax
 * funding account, and send naira to Quidax. Every owner action is audited.
 */
@Public() // opts out of the USER guard; AdminGuard takes over
@UseGuards(AdminGuard)
@RateLimit('default')
@ApiTags('admin')
@ApiBearerAuth('admin')
@Controller('admin/treasury')
export class TreasuryAdminController {
  constructor(
    private readonly treasury: TreasuryService,
    private readonly admin: AdminService,
  ) {}

  @Get()
  @RequirePermissions('treasury.view')
  snapshot() {
    return this.treasury.snapshot();
  }

  /** Banks the naira rail can pay, for the funding-account picker. */
  @Get('banks')
  @RequirePermissions('treasury.view')
  banks() {
    return this.treasury.banks();
  }

  /** The bank's name for an account (no saving). */
  @Post('check-name')
  @HttpCode(200)
  @RequirePermissions('treasury.manage')
  checkName(@Body() dto: TreasuryCheckNameDto) {
    return this.treasury.checkName(dto);
  }

  /** Owners only (the service checks), with the password: payout reserve and funding account. */
  @Put('settings')
  @RequirePermissions('treasury.manage')
  async saveSettings(@CurrentAdmin() actor: AdminJwtPayload, @Body() dto: TreasurySettingsDto, @Req() req: Request) {
    const { password, ...rest } = dto;
    const { before, after } = await this.treasury.saveSettings({ id: actor.sub, role: actor.role }, { ...rest, password });
    await this.admin.audit(actor.sub, 'treasury.settings', 'TreasurySettings', 'default', before, after, req.ip);
    return this.treasury.snapshot();
  }

  /** Ask the rail about one move now, instead of waiting for the 10-minute re-check. */
  @Post('moves/:id/check')
  @HttpCode(200)
  @RequirePermissions('treasury.manage')
  checkMove(@Param('id') id: string) {
    return this.treasury.checkMove(id);
  }

  /** Owners only, with the password: a move the rail has no record of after 30 minutes. */
  @Post('moves/:id/mark-failed')
  @HttpCode(200)
  @RequirePermissions('treasury.manage')
  async markFailed(@CurrentAdmin() actor: AdminJwtPayload, @Param('id') id: string, @Body() dto: TreasuryPasswordDto, @Req() req: Request) {
    const { before, after } = await this.treasury.markFailed({ id: actor.sub, role: actor.role }, id, dto.password);
    await this.admin.audit(actor.sub, 'treasury.move.mark_failed', 'TreasuryMove', id, before, after, req.ip);
    return this.treasury.snapshot();
  }

  /** Owners only (the service checks), with the password: send naira from the rail to Quidax. */
  @Post('moves')
  @RequirePermissions('treasury.manage')
  async sendToQuidax(@CurrentAdmin() actor: AdminJwtPayload, @Body() dto: TreasuryMoveDto, @Req() req: Request) {
    const result = await this.treasury.sendToQuidax({ id: actor.sub, role: actor.role }, { amount: dto.amount, password: dto.password });
    await this.admin.audit(
      actor.sub,
      'treasury.move',
      'TreasuryMove',
      result.moveId,
      null,
      { amount: dto.amount, reference: result.reference, status: result.status, reason: result.reason },
      req.ip,
    );
    return result;
  }
}
