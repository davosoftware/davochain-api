import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PolicyAction } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequiresAction } from '../levels/requires-action.decorator';
import { PausedDuringMaintenance } from '../common/maintenance.guard';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { AddBankAccountDto, AddCryptoAddressDto } from './dto';
import { SavedDestinationsService } from './saved-destinations.service';

/**
 * Where a customer's withdrawals may go (Part 2, C6). Adding checks the
 * password, so it shares the change-password rate limit.
 */
@ApiTags('withdrawals')
@ApiBearerAuth('user')
@Controller('me')
export class SavedDestinationsController {
  constructor(private readonly saved: SavedDestinationsService) {}

  @Get('bank-accounts')
  listBanks(@CurrentUser('sub') userId: string) {
    return this.saved.listBanks(userId);
  }

  @RequiresAction(PolicyAction.NGN_WITHDRAW)
  @RateLimit('auth.changePassword')
  @PausedDuringMaintenance()
  @Post('bank-accounts')
  addBank(@CurrentUser('sub') userId: string, @Body() dto: AddBankAccountDto) {
    return this.saved.addBank(userId, dto);
  }

  @Delete('bank-accounts/:id')
  async removeBank(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    await this.saved.remove('bank', userId, id, 'user');
    return { removed: true };
  }

  @Get('crypto-addresses')
  listCrypto(@CurrentUser('sub') userId: string) {
    return this.saved.listCrypto(userId);
  }

  @RequiresAction(PolicyAction.CRYPTO_WITHDRAW)
  @RateLimit('auth.changePassword')
  @PausedDuringMaintenance()
  @Post('crypto-addresses')
  addCrypto(@CurrentUser('sub') userId: string, @Body() dto: AddCryptoAddressDto) {
    return this.saved.addCrypto(userId, dto);
  }

  @Delete('crypto-addresses/:id')
  async removeCrypto(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    await this.saved.remove('crypto', userId, id, 'user');
    return { removed: true };
  }
}
