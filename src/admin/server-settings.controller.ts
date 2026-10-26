import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Allow, IsString, MaxLength, MinLength } from 'class-validator';
import { Public } from '../auth/public.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { AdminGuard } from './admin.guard';
import { CurrentAdmin } from './current-admin.decorator';
import type { AdminJwtPayload } from './admin.service';
import { ServerSettingsService } from '../settings/server-settings.service';
import type { ServerSettingKey } from '../settings/server-settings.registry';

export class ConfirmWithPasswordDto {
  @IsString() @MaxLength(128) password!: string;
  @IsString() @MinLength(10) @MaxLength(500) reason!: string;
}

export class SetServerSettingDto extends ConfirmWithPasswordDto {
  /** A boolean, number or text, depending on the setting; ServerSettingsService checks it. */
  @Allow() value!: unknown;
}

/**
 * System → Server settings (spec 2026-10-26). Owners only: the service checks
 * the role and the password on every change (no permission grants it to a
 * sub-admin). Reading the screen is owners only too.
 */
@Public() // opts out of the USER guard; AdminGuard takes over
@UseGuards(AdminGuard)
@RateLimit('default')
@ApiTags('admin')
@ApiBearerAuth('admin')
@Controller('admin')
export class ServerSettingsController {
  constructor(private readonly settings: ServerSettingsService) {}

  private actor(admin: AdminJwtPayload, req: Request) {
    return { id: admin.sub, role: admin.role, email: admin.email, ip: req.ip };
  }

  @Get('server-settings')
  list(@CurrentAdmin() admin: AdminJwtPayload) {
    if (admin.role !== 'OWNER') return { owner: false, settings: [] };
    return { owner: true, settings: this.settings.view() };
  }

  @Put('server-settings/:key')
  set(@CurrentAdmin() admin: AdminJwtPayload, @Param('key') key: string, @Body() dto: SetServerSettingDto, @Req() req: Request) {
    return this.settings.set(this.actor(admin, req), key as ServerSettingKey, dto.value, dto.password, dto.reason);
  }

  @Delete('server-settings/:key')
  reset(@CurrentAdmin() admin: AdminJwtPayload, @Param('key') key: string, @Body() dto: ConfirmWithPasswordDto, @Req() req: Request) {
    return this.settings.reset(this.actor(admin, req), key as ServerSettingKey, dto.password, dto.reason);
  }

  /** Emergency: every customer is signed out now. Owners only, password and reason; owners are emailed. */
  @Post('emergency/sign-out-customers')
  @HttpCode(200)
  signOutCustomers(@CurrentAdmin() admin: AdminJwtPayload, @Body() dto: ConfirmWithPasswordDto, @Req() req: Request) {
    return this.settings.signOutAllCustomers(this.actor(admin, req), dto.password, dto.reason);
  }
}
