import { BadRequestException } from '@nestjs/common';
import { GiftCardTradeStatus, KycStatus, KycTier, PolicyAction, PolicyLevel, TxStatus, TxType } from '@prisma/client';
import { ACTION_TOTALS, actionFor, lagosDay } from './daily-usage';
import { DailyUsageService } from './daily-usage.service';
import { dec } from '../common/money';

/**
 * The daily limits monitor (27 Oct 2026): for any day, how much of each limit
 * every customer used. It counts with ACTION_TOTALS, the same definition the
 * limits check (LevelPolicyService.usedToday) uses, so the two can't disagree.
 */
describe('which transactions count toward which limit (shared with the limits check)', () => {
  it.each([
    [PolicyAction.BUY, { type: TxType.BUY, fromAsset: 'ngn', toAsset: 'btc' }],
    [PolicyAction.SELL, { type: TxType.SELL, fromAsset: 'btc', toAsset: 'ngn' }],
    [PolicyAction.SWAP, { type: TxType.SWAP, fromAsset: 'usdt', toAsset: 'btc' }],
    [PolicyAction.CRYPTO_WITHDRAW, { type: TxType.WITHDRAWAL, fromAsset: 'btc', toAsset: null }],
    [PolicyAction.NGN_WITHDRAW, { type: TxType.WITHDRAWAL, fromAsset: 'ngn', toAsset: null }],
    [PolicyAction.NGN_DEPOSIT, { type: TxType.DEPOSIT, fromAsset: null, toAsset: 'ngn' }],
  ])('%s', (action, row) => {
    expect(actionFor(row)).toBe(action);
  });

  it('a crypto deposit counts toward nothing (receiving crypto has no daily total)', () => {
    expect(actionFor({ type: TxType.DEPOSIT, fromAsset: null, toAsset: 'btc' })).toBeNull();
    expect(ACTION_TOTALS.CRYPTO_DEPOSIT).toEqual({ from: 'none' });
  });

  it('dollar actions add up the dollar value; naira actions the naira amount', () => {
    expect(ACTION_TOTALS.BUY).toMatchObject({ sum: 'usdValue' });
    expect(ACTION_TOTALS.NGN_WITHDRAW).toMatchObject({ sum: 'toAmount' });
    expect(ACTION_TOTALS.GIFTCARD_SELL).toEqual({ from: 'giftcards' });
  });
});

describe('a day is midnight to midnight in Lagos', () => {
  it('27 Oct = 26 Oct 23:00 UTC to 27 Oct 23:00 UTC', () => {
    expect(lagosDay('2026-10-27')).toEqual({ date: '2026-10-27', start: new Date('2026-10-26T23:00:00Z'), end: new Date('2026-10-27T23:00:00Z') });
  });

  it('no date = today in Lagos', () => {
    const d = lagosDay(undefined, new Date('2026-10-27T23:30:00Z')); // 00:30 on the 28th in Lagos
    expect(d.date).toBe('2026-10-28');
  });

  it('a date that is not a real day is refused', () => {
    expect(() => lagosDay('2026-13-40')).toThrow(BadRequestException);
    expect(() => lagosDay('yesterday')).toThrow(BadRequestException);
  });
});

function build() {
  const users = [
    { id: 'u1', email: 'ada@x.com', firstName: 'Ada', lastName: 'Obi', kycTier: KycTier.TIER_1, kycStatus: KycStatus.APPROVED, amlStatus: 'CLEAR' },
    { id: 'u2', email: 'bayo@x.com', firstName: 'Bayo', lastName: 'Ade', kycTier: KycTier.TIER_1, kycStatus: KycStatus.PENDING, amlStatus: 'NOT_SCREENED' },
  ];
  const prisma = {
    transaction: {
      groupBy: jest.fn(async () => [
        { userId: 'u1', type: TxType.BUY, fromAsset: 'ngn', toAsset: 'btc', _sum: { usdValue: dec('800'), toAmount: dec('0.01') } },
        { userId: 'u1', type: TxType.WITHDRAWAL, fromAsset: 'ngn', toAsset: null, _sum: { usdValue: null, toAmount: dec('150000') } },
        { userId: 'u2', type: TxType.SWAP, fromAsset: 'usdt', toAsset: 'btc', _sum: { usdValue: dec('50'), toAmount: dec('0.0008') } },
      ]),
    },
    giftCardTrade: { groupBy: jest.fn(async () => [{ userId: 'u1', _sum: { expectedNgn: dec('30000') } }]) },
    user: { findMany: jest.fn(async () => users) },
    levelRule: {
      findMany: jest.fn(async () => [
        { level: PolicyLevel.BASIC, action: PolicyAction.BUY, allowed: true, currency: 'USD', minPerTx: null, maxPerTx: dec('500'), maxPerDay: dec('1000') },
        { level: PolicyLevel.BASIC, action: PolicyAction.NGN_WITHDRAW, allowed: true, currency: 'NGN', minPerTx: null, maxPerTx: null, maxPerDay: dec('200000') },
        { level: PolicyLevel.BASIC, action: PolicyAction.GIFTCARD_SELL, allowed: true, currency: 'USD', minPerTx: null, maxPerTx: null, maxPerDay: dec('100') },
        { level: PolicyLevel.NONE, action: PolicyAction.SWAP, allowed: false, currency: 'USD', minPerTx: null, maxPerTx: null, maxPerDay: null },
      ]),
    },
  };
  const policy = { fx: jest.fn(async () => ({ ngnPerUsd: dec('1500') })) };
  return { svc: new DailyUsageService(prisma as never, policy as never), prisma };
}

describe('DailyUsageService.forDay', () => {
  it('works out each customer\'s use of each limit, in the limit\'s own currency', async () => {
    const { svc, prisma } = build();
    const day = await svc.forDay({ date: '2026-10-27' });
    const where = (prisma.transaction.groupBy.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({ createdAt: { gte: new Date('2026-10-26T23:00:00Z'), lt: new Date('2026-10-27T23:00:00Z') }, status: { not: TxStatus.FAILED } });
    expect((prisma.giftCardTrade.groupBy.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where).toMatchObject({ status: { not: GiftCardTradeStatus.REJECTED } });

    const ada = day.customers.find((c) => c.userId === 'u1')!;
    expect(ada).toMatchObject({ level: PolicyLevel.BASIC, email: 'ada@x.com', name: 'Ada Obi' });
    const buy = ada.actions.find((a) => a.action === PolicyAction.BUY)!;
    expect(buy).toMatchObject({ currency: 'USD', used: '800.00', maxPerDay: '1000.00', remaining: '200.00', percent: 80, allowed: true });
    const ngnOut = ada.actions.find((a) => a.action === PolicyAction.NGN_WITHDRAW)!;
    expect(ngnOut).toMatchObject({ currency: 'NGN', used: '150000.00', percent: 75 });
    // A naira gift-card total against a dollar limit: ₦30,000 / 1500 = $20 of $100.
    expect(ada.actions.find((a) => a.action === PolicyAction.GIFTCARD_SELL)).toMatchObject({ currency: 'USD', used: '20.00', percent: 20 });
    expect(ada.highestPercent).toBe(80);
  });

  it('a customer not verified is held to the None level (as the limits check does)', async () => {
    const { svc } = build();
    const day = await svc.forDay({ date: '2026-10-27' });
    const bayo = day.customers.find((c) => c.userId === 'u2')!;
    expect(bayo.level).toBe(PolicyLevel.NONE);
    expect(bayo.actions.find((a) => a.action === PolicyAction.SWAP)).toMatchObject({ allowed: false, used: '50.00', percent: null });
  });

  it('busiest first; "near the limit" keeps only customers at or above the percentage', async () => {
    const { svc } = build();
    const all = await svc.forDay({ date: '2026-10-27' });
    expect(all.customers.map((c) => c.userId)).toEqual(['u1', 'u2']);
    const near = await svc.forDay({ date: '2026-10-27', nearPercent: 90 });
    expect(near.customers).toEqual([]);
  });

  it('one customer only (for the Users page)', async () => {
    const { svc, prisma } = build();
    await svc.forDay({ date: '2026-10-27', userId: 'u1' });
    expect((prisma.transaction.groupBy.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where).toMatchObject({ userId: 'u1' });
  });
});
