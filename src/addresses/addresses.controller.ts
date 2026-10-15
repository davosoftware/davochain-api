import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsString, Matches, MaxLength } from 'class-validator';
import { AddressesService } from './addresses.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequiresAction } from '../levels/requires-action.decorator';
import { PolicyAction } from '@prisma/client';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PausedDuringMaintenance } from '../common/maintenance.guard';

export class CreateAddressDto {
  @IsString()
  @MaxLength(20)
  @Matches(/^[a-z0-9]+$/i, { message: 'Invalid asset code' })
  asset!: string;

  @IsString()
  @MaxLength(40)
  network!: string;
}

@ApiTags('deposits')
@ApiBearerAuth('user')
@Controller('deposits')
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  /**
   * Get-or-create. Deliberately POST: it may create upstream state, and it must
   * not be retried by a browser or prefetched.
   */
  @RequiresAction(PolicyAction.CRYPTO_DEPOSIT)
  @PausedDuringMaintenance()
  @Post('address')
  create(@CurrentUser('sub') userId: string, @Body() dto: CreateAddressDto) {
    return this.addresses.getOrCreate(userId, dto.asset, dto.network);
  }

  @Get('addresses')
  list(@CurrentUser('sub') userId: string) {
    return this.addresses.listForUser(userId);
  }
}
