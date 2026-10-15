import { BadRequestException } from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { dec } from '../common/money';

/**
 * H10 (PROJECT_REVIEW): a swap quote returned a "maximum" but never checked it,
 * so swaps had no size limit at all. And the platform-wide MAX_TRADE_USD was
 * never read for any trade.
 */
function build(opts: { maxTradeUsdEnv?: number } = {}) {
  const prisma = {
    transaction: { aggregate: jest.fn(async () => ({ _sum: { usdValue: dec('0') } })) },
    rateQuote: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'q1', ...data, expiresAt: new Date(Date.now() + 12_000) })) },
  };
  const rates = {
    rateConfig: jest.fn(async () => ({ id: 'cfg1', maxTradeUsd: '2000', swapFeeUsd: '1' })),
    price: jest.fn(async (code: string) => ({ priceUsd: code === 'btc' ? dec('60000') : dec('3000') })),
  };
  const assets = { require: jest.fn(async (code: string) => ({ code, transferStep: '0.00000001', displayScale: 8 })) };
  const config = {
    get: (k: string) =>
      ({ MAX_TRADE_USD: opts.maxTradeUsdEnv, MAX_USER_DAILY_USD: 1e9, MAX_PLATFORM_DAILY_USD: 1e9, QUOTE_TTL_SECONDS: 12 })[k],
  };
  return new QuotesService(
    prisma as never,
    rates as never,
    { resolve: jest.fn(async () => null) } as never,
    assets as never,
    { getBalance: jest.fn(async () => ({ available: dec('100') })) } as never,
    { assertTradingAllowed: jest.fn(async () => undefined) } as never,
    config as never,
  );
}

describe('H10: swaps have a maximum size', () => {
  it('a swap worth more than the per-coin maximum ($2,000) is refused', async () => {
    const err = await build().quoteSwap('u1', 'btc', 'eth', dec('0.05')).catch((e) => e); // $3,000
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Maximum single trade is $2000.00.');
  });

  it('a swap within the maximum is quoted', async () => {
    await expect(build().quoteSwap('u1', 'btc', 'eth', dec('0.01'))).resolves.toBeDefined(); // $600
  });

  it('MAX_TRADE_USD caps every trade below the per-coin maximum', async () => {
    const err = await build({ maxTradeUsdEnv: 500 }).quoteSwap('u1', 'btc', 'eth', dec('0.01')).catch((e) => e); // $600
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Maximum single trade is $500.00.');
  });
});
