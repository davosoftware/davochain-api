import { BadRequestException } from '@nestjs/common';
import { TxStatus, TxType } from '@prisma/client';
import { assertDailyCaps, startOfLagosDay } from './daily-limits';
import { dec } from '../common/money';

/**
 * H10 (PROJECT_REVIEW): MAX_USER_DAILY_USD and MAX_PLATFORM_DAILY_USD were
 * validated at boot and never read, so one user (or everyone together) could
 * trade without any daily limit. The day is the Lagos day.
 */
function table(mineUsd: string, allUsd: string) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    t: {
      transaction: {
        aggregate: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          calls.push(where);
          return { _sum: { usdValue: dec('userId' in where ? mineUsd : allUsd) } };
        }),
      },
    },
  };
}
const caps = { userUsd: dec('5000'), platformUsd: dec('50000') };

describe('H10: daily trading limits', () => {
  it('the trading day starts at midnight in Lagos (23:00 UTC the day before)', () => {
    expect(startOfLagosDay(new Date('2026-10-15T10:00:00Z')).toISOString()).toBe('2026-10-14T23:00:00.000Z');
    expect(startOfLagosDay(new Date('2026-10-15T23:30:00Z')).toISOString()).toBe('2026-10-15T23:00:00.000Z');
  });

  it('a trade within both limits passes', async () => {
    const { t } = table('1000', '10000');
    await expect(assertDailyCaps(t as never, 'u1', dec('500'), caps)).resolves.toBeUndefined();
  });

  it('a trade that would take the user over $5,000 today is refused, saying what is left', async () => {
    const { t } = table('4800', '10000');
    const err = await assertDailyCaps(t as never, 'u1', dec('300'), caps).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('This trade would take you over your daily limit of $5000.00. You can trade $200.00 more today.');
  });

  it('a trade that would take the whole platform over its daily limit is refused', async () => {
    const { t } = table('0', '49900');
    const err = await assertDailyCaps(t as never, 'u1', dec('200'), caps).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Trading has reached its daily limit. Please try again tomorrow.');
  });

  it('counts buys, sells and swaps from today, but not failed (refunded) ones', async () => {
    const { t, calls } = table('0', '0');
    await assertDailyCaps(t as never, 'u1', dec('1'), caps, new Date('2026-10-15T10:00:00Z'));
    expect(calls[0]).toMatchObject({
      userId: 'u1',
      type: { in: [TxType.BUY, TxType.SELL, TxType.SWAP] },
      status: { not: TxStatus.FAILED },
      createdAt: { gte: new Date('2026-10-14T23:00:00.000Z') },
    });
  });
});

describe('H10: a trade checks the daily limits inside the write that locks the money', () => {
  it('a buy over the daily limit locks nothing', async () => {
    const { TradesService } = await import('./trades.service');
    const locked: string[] = [];
    const t = { transaction: { aggregate: jest.fn(async () => ({ _sum: { usdValue: dec('4950') } })), create: jest.fn() } };
    const svc = Object.create(TradesService.prototype) as Record<string, unknown>;
    Object.assign(svc, {
      flags: { assertTradingAllowed: jest.fn(async () => undefined) },
      assets: { require: jest.fn(async () => ({ code: 'btc' })) },
      quidax: { newReference: () => 'ref' },
      ledger: { lock: jest.fn(async () => locked.push('lock')) },
      config: { get: (k: string) => ({ MAX_USER_DAILY_USD: 5000, MAX_PLATFORM_DAILY_USD: 50000 })[k] },
      prisma: {
        inventorySetting: { findUnique: jest.fn(async () => ({ fallbackSwapEnabled: true })) },
        serializable: jest.fn((fn: (x: unknown) => unknown) => fn(t)),
      },
      settlement: {
        inventory: jest.fn(async () => dec('1')),
        mainAccount: jest.fn(async () => 'main'),
        quidaxIdFor: jest.fn(async () => 'sub1'),
      },
    });
    const buy = (svc.buy as (...a: unknown[]) => Promise<unknown>).bind(svc);
    const err = await buy('u1', {
      id: 'q1', fromAsset: 'ngn', toAsset: 'btc', fromAmount: '150000', toAmount: '0.001', displayedRate: '1500',
      quidaxRate: '1500', usdValue: '100', feeUsd: null, gateApplied: '0', rateConfigId: 'cfg1',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(locked).toEqual([]);
  });
});
