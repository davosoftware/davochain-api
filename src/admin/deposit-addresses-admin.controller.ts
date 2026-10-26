import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsString, MaxLength } from 'class-validator';
import { Public } from '../auth/public.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { AdminGuard } from './admin.guard';
import { RequirePermissions } from './require-permissions.decorator';
import { CurrentAdmin } from './current-admin.decorator';
import { DepositAddressParams, DepositAddressesAdminService } from './deposit-addresses-admin.service';

export class AutoCreateDto {
  @IsBoolean() enabled!: boolean;
  @IsString() @MaxLength(128) password!: string;
}

/**
 * People → Crypto addresses (spec 2026-10-26): customers' deposit addresses,
 * Check again / Try again, and which coin networks are made in advance.
 */
@Public() // opts out of the USER guard; AdminGuard takes over
@UseGuards(AdminGuard)
@RateLimit('default')
@ApiTags('admin')
@ApiBearerAuth('admin')
@Controller('admin')
export class DepositAddressesAdminController {
  constructor(private readonly addresses: DepositAddressesAdminService) {}

  @Get('deposit-addresses')
  @RequirePermissions('users.view')
  list(@Query() q: DepositAddressParams) {
    return this.addresses.list(q);
  }

  /** PENDING: ask Quidax now. FAILED: try again (a late address first, else one new request). */
  @Post('deposit-addresses/:id/retry')
  @HttpCode(200)
  @RequirePermissions('users.manage')
  retry(@CurrentAdmin('sub') adminId: string, @Param('id') id: string, @Req() req: Request) {
    return this.addresses.retry(adminId, id, req.ip);
  }

  @Get('asset-networks')
  @RequirePermissions('users.view')
  networks() {
    return this.addresses.networks();
  }

  @Put('asset-networks/:asset/:network/auto-create')
  @RequirePermissions('inventory.manage')
  setAutoCreate(
    @CurrentAdmin('sub') adminId: string,
    @Param('asset') asset: string,
    @Param('network') network: string,
    @Body() dto: AutoCreateDto,
    @Req() req: Request,
  ) {
    return this.addresses.setAutoCreate(adminId, asset, network, dto.enabled, dto.password, req.ip);
  }
}
