import { Body, Controller, Get, Post, Query, UseInterceptors } from '@nestjs/common';
import { KycTier } from '@prisma/client';
import { WithdrawalsService } from './withdrawals.service';
import { WithdrawCryptoDto } from './dto';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequiresKyc } from '../auth/jwt-auth.guard';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

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
   * Prices the fee only. `payoutAvailable: false` comes back because the naira
   * rail is not built — the ladder can be agreed and shown before the provider
   * is chosen, which beats inventing a number on the day it arrives.
   */
  @Get('quote/ngn')
  quoteNgn(@CurrentUser('sub') userId: string, @Query('amount') amount: string) {
    return this.withdrawals.quoteNgnWithdrawalFee(userId, amount);
  }

  @RequiresKyc(KycTier.TIER_1)
  @UseInterceptors(IdempotencyInterceptor)
  @Post('crypto')
  withdraw(@CurrentUser('sub') userId: string, @Body() dto: WithdrawCryptoDto) {
    return this.withdrawals.withdrawCrypto(userId, dto);
  }
}
