import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { AdminGuard } from './admin.guard';
import { CurrentAdmin } from './current-admin.decorator';
import { RequirePermissions } from './require-permissions.decorator';
import type { AdminJwtPayload } from './admin.service';
import { AccountClosureService } from './account-closure.service';
import { IsIn, IsOptional } from 'class-validator';
import { ConfirmWithPasswordDto } from './server-settings.controller';
import { DATA_CHOICES, type DataChoice } from './account-closure.service';

export class CloseAccountDto extends ConfirmWithPasswordDto {
  /** KEEP (default), DELETE_LATER (after the months in Server settings) or DELETE_NOW. */
  @IsOptional() @IsIn(DATA_CHOICES as unknown as string[]) dataChoice?: DataChoice;
}

/**
 * People → Users → Close account (28 Oct 2026). Anyone who can see users may
 * ask whether an account can be closed; only an owner can close one, with
 * their password and a reason (the service checks the role).
 */
@Public() // opts out of the USER guard; AdminGuard takes over
@UseGuards(AdminGuard)
@RateLimit('default')
@ApiTags('admin')
@ApiBearerAuth('admin')
@Controller('admin/users')
export class AccountClosureController {
  constructor(private readonly closure: AccountClosureService) {}

  /** What stops this account being closed right now (money held, things in progress). */
  @Get(':id/close-check')
  @RequirePermissions('users.view')
  check(@Param('id', ParseUUIDPipe) id: string) {
    return this.closure.check(id);
  }

  @Post(':id/close')
  @HttpCode(200)
  close(@CurrentAdmin() admin: AdminJwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseAccountDto, @Req() req: Request) {
    return this.closure.close({ id: admin.sub, role: admin.role, ip: req.ip }, id, dto);
  }

  /** Owners only: delete the personal data of an account that is already closed. */
  @Post(':id/delete-data')
  @HttpCode(200)
  deleteData(@CurrentAdmin() admin: AdminJwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmWithPasswordDto, @Req() req: Request) {
    return this.closure.deleteDataNow({ id: admin.sub, role: admin.role, ip: req.ip }, id, dto);
  }
}
