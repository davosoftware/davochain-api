import { FeeKind } from '@prisma/client';
import { QuotesService } from './quotes.service';
import { dec } from '../common/money';

/**
 * M11 (decision 15 Oct 2026): a sell quote = Quidax's SELLING price minus OUR
 * sell margin. The sell margin is its own admin ladder (SELL_RATE). Until an
 * admin sets one, the buy margin (RATE ladder, then the flat gate) is used, so
 * the margin does not change on day one; only the base price is corrected.
 */
function build(bands: Partial<Record<FeeKind, string>>) {
  const resolved: FeeKind[] = [];
  const created: Array<Record<string, unknown>> = [];
  const svc = new QuotesService(
    {
      user: { findUnique: jest.fn(async () => ({ kycTier: 'TIER_1' })) },
      transaction: { aggregate: jest.fn(async () => ({ _sum: { usdValue: dec('0') } })) },
      rateQuote: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => (created.push(data), { id: 'q1', ...data, expiresAt: new Date(Date.now() + 12_000) })) },
    } as never,
    {
      rateConfig: jest.fn(async () => ({ id: 'cfg1', maxTradeUsd: '2000', floorUsd: '10', gateNgnPerUsd: '20' })),
      price: jest.fn(async () => ({ ngnPerUsd: dec('1600'), priceUsd: dec('62500') })),
      sellPrice: jest.fn(async () => ({ ngnPerUsd: dec('1568'), priceUsd: dec('62500') })),
      displayRate: (side: 'buy' | 'sell', r: ReturnType<typeof dec>, g: ReturnType<typeof dec>) => (side === 'buy' ? r.plus(g) : r.minus(g)),
    } as never,
    {
      resolve: jest.fn(async (kind: FeeKind) => {
        resolved.push(kind);
        const v = bands[kind];
        return v === undefined ? null : { value: dec(v), minAmount: dec(0), maxAmount: null, fromGlobal: true };
      }),
    } as never,
    {
      require: jest.fn(async () => ({ code: 'btc', transferStep: '0.00000001', displayScale: 8, transferMin: '0' })),
      minimumUsd: jest.fn(async () => dec('10')),
      assertTransferable: jest.fn(),
    } as never,
    { getBalance: jest.fn(async () => ({ available: dec('1000000000') })) } as never,
    { assertTradingAllowed: jest.fn(async () => undefined) } as never,
    { get: () => undefined } as never,
    { fx: async () => ({ ngnPerUsd: dec('1500') }), assertWithinLimits: async () => undefined } as never,
    {} as never, // settlement: only swaps use it
  );
  return { svc, resolved, created };
}

describe('M11: a sell is priced from Quidax\'s selling price minus our sell margin', () => {
  it('uses the sell reference (₦1,568/$) and the SELL_RATE margin (₦30/$): ₦1,538 per $', async () => {
    const { svc, created } = build({ SELL_RATE: '30', RATE: '20' });
    const q = await svc.quoteSell('u1', 'btc', dec('0.01'));
    expect(q.rate).toBe('1538.0000');
    expect(created[0]).toMatchObject({ quidaxRate: '1568', gateApplied: '30' });
  });

  it('with no sell ladder, falls back to the buy ladder (RATE), so the margin is unchanged', async () => {
    const { svc, resolved } = build({ RATE: '20' });
    const q = await svc.quoteSell('u1', 'btc', dec('0.01'));
    expect(q.rate).toBe('1548.0000');
    expect(resolved).toEqual([FeeKind.SELL_RATE, FeeKind.RATE]);
  });

  it('with no ladder at all, falls back to the flat gate on the rate config', async () => {
    const { svc } = build({});
    expect((await svc.quoteSell('u1', 'btc', dec('0.01'))).rate).toBe('1548.0000');
  });

  it('a buy is unchanged: buying price plus the buy margin', async () => {
    const { svc } = build({ RATE: '20', SELL_RATE: '30' });
    const q = await svc.quoteBuy('u1', 'btc', dec('100000'));
    expect(q.rate).toBe('1620.0000');
  });
});
