import { BadRequestException } from '@nestjs/common';
import { WithdrawalsService } from './withdrawals.service';

/**
 * Fee quotes (8.1 crypto, 8.4 naira) take the amount from the query string.
 * A missing or malformed one used to reach `new Decimal()` and come back as a
 * 500; it must be a 400 that names the problem, before anything else is asked.
 */
function build() {
  const assets = { require: jest.fn() };
  const rates = { rateConfig: jest.fn() };
  const prisma = { user: { findUnique: jest.fn() } };
  const kycLimits = { check: jest.fn() };
  const service = new WithdrawalsService(
    prisma as never,
    {} as never, // quidax
    {} as never, // ledger
    assets as never,
    {} as never, // settlement
    rates as never,
    { resolve: jest.fn() } as never, // feeBands
    kycLimits as never,
    {} as never, // flags
    {} as never, // notifications
    { fx: async () => ({ ngnPerUsd: '1500' }), assertCooledOff: async () => undefined, assertWithinLimits: async () => undefined, rulesFor: async () => [] } as never, // policy
    {} as never, // naira rail
  );
  return { service, assets, rates, prisma, kycLimits };
}

const BAD = [undefined, '', '   ', 'abc', '12abc', '1e5', '-5', '0', '0.00', 'NaN', 'Infinity', '1,000'];

describe('crypto withdrawal fee quote (8.1): the amount', () => {
  it.each(BAD)('%p is a 400, and nothing is looked up', async (amount) => {
    const { service, assets, rates } = build();
    const err = await service.quoteFee('btc', amount as string, 'btc').catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Enter an amount greater than zero');
    expect(assets.require).not.toHaveBeenCalled();
    expect(rates.rateConfig).not.toHaveBeenCalled();
  });

  it('a missing network is a 400 too', async () => {
    const { service, assets } = build();
    const err = await service.quoteFee('btc', '0.01', undefined as unknown as string).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Choose a network');
    expect(assets.require).not.toHaveBeenCalled();
  });

  it('a missing asset is a 400 too', async () => {
    const { service } = build();
    const err = await service.quoteFee(undefined as unknown as string, '0.01', 'btc').catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Choose a coin');
  });
});

describe('naira withdrawal fee quote (8.4): the amount', () => {
  it.each(BAD)('%p is a 400, and nothing is looked up', async (amount) => {
    const { service, prisma, kycLimits } = build();
    const err = await service.quoteNgnWithdrawalFee('user-1', amount as string).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Enter an amount greater than zero');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(kycLimits.check).not.toHaveBeenCalled();
  });
});
