import { Body, Controller, Get, Post, Query, UseInterceptors } from '@nestjs/common';
import { PolicyAction } from '@prisma/client';
import { WithdrawalsService } from './withdrawals.service';
import { VerifyNgnBankAccountDto, WithdrawCryptoDto, WithdrawNgnDto } from './dto';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequiresAction } from '../levels/requires-action.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PausedDuringMaintenance } from '../common/maintenance.guard';

@ApiTags('withdrawals')
@ApiBearerAuth('user')
@Controller('withdrawals')
export class WithdrawalsController {
  constructor(private readonly withdrawals: WithdrawalsService) {}

  @Get()
  history(@CurrentUser('sub') userId: string, @Query('limit') limit?: string) {
    return this.withdrawals.history(userId, limit ? Number(limit) : 50);
  }

  /** Show the chain fee and your fee as separate lines, never one blended number. */
  @Get('quote')
  quote(
    @Query('asset') asset: string,
    @Query('amount') amount: string,
    @Query('network') network: string,
  ) {
    return this.withdrawals.quoteFee(asset, amount, network);
  }

  /**
   * What cashing out naira to a bank would cost.
   *
   * Prices the fee and checks the user's limits. `payoutAvailable` mirrors the
   * naira withdrawal switch, so the app can disable payout while it is off.
   */
  @Get('quote/ngn')
  quoteNgn(@CurrentUser('sub') userId: string, @Query('amount') amount: string) {
    return this.withdrawals.quoteNgnWithdrawalFee(userId, amount);
  }

  @Get('ngn/banks')
  ngnBanks() {
    return this.withdrawals.ngnBanks();
  }

  @RequiresAction(PolicyAction.NGN_WITHDRAW)
  @PausedDuringMaintenance()
  @Post('ngn/verify-account')
  verifyNgnBankAccount(@Body() dto: VerifyNgnBankAccountDto) {
    return this.withdrawals.verifyNgnBankAccount(dto);
  }

  @RequiresAction(PolicyAction.NGN_WITHDRAW)
  @UseInterceptors(IdempotencyInterceptor)
  @PausedDuringMaintenance()
  @Post('ngn')
  withdrawNgn(@CurrentUser('sub') userId: string, @Body() dto: WithdrawNgnDto) {
    return this.withdrawals.withdrawNgnToSaved(userId, dto);
  }

  @RequiresAction(PolicyAction.CRYPTO_WITHDRAW)
  @UseInterceptors(IdempotencyInterceptor)
  @PausedDuringMaintenance()
  @Post('crypto')
  withdraw(@CurrentUser('sub') userId: string, @Body() dto: WithdrawCryptoDto) {
    return this.withdrawals.withdrawCryptoToSaved(userId, dto);
  }
}
