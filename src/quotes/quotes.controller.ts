import { Body, Controller, Post, UseInterceptors } from '@nestjs/common';
import { KycTier } from '@prisma/client';
import { QuotesService } from './quotes.service';
import { TradesService } from '../trades/trades.service';
import { QuoteDto, ExecuteTradeDto } from './dto';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequiresKyc } from '../auth/jwt-auth.guard';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { dec } from '../common/money';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('trading')
@ApiBearerAuth('user')
@Controller()
export class QuotesController {
  constructor(
    private readonly quotes: QuotesService,
    private readonly trades: TradesService,
  ) {}

  /**
   * A live quote, good for 12 seconds. The app fades Continue when it expires
   * and requotes on an amount change or an explicit tap — it never silently
   * refreshes a price the user is looking at.
   */
  @RequiresKyc(KycTier.TIER_1)
  @Post('quotes')
  async quote(@CurrentUser('sub') userId: string, @Body() dto: QuoteDto) {
    const amount = dec(dto.amount);

    switch (dto.side) {
      case 'buy':
        return this.quotes.quoteBuy(userId, dto.toAsset, amount);
      case 'sell':
        return this.quotes.quoteSell(userId, dto.fromAsset, amount);
      case 'swap':
        return this.quotes.quoteSwap(userId, dto.fromAsset, dto.toAsset, amount);
    }
  }

  /** Execute a quote. Idempotency-Key required — this one moves money. */
  @RequiresKyc(KycTier.TIER_1)
  @UseInterceptors(IdempotencyInterceptor)
  @Post('trades')
  async execute(@CurrentUser('sub') userId: string, @Body() dto: ExecuteTradeDto) {
    // Consume first: single-use, and expiry is enforced here rather than deeper in.
    const quote = await this.quotes.consume(userId, dto.quoteId);
    return this.trades.execute(userId, quote);
  }
}
