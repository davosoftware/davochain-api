import { BadRequestException } from '@nestjs/common';
import { GiftCardsService } from './giftcards.service';
import { dec } from '../common/money';

describe('Gift-card selling obeys the daily limit (decision 15 Oct)', () => {
  it('two ₦600,000 cards at once against a ₦1,000,000 daily limit: exactly one is accepted', async () => {
    const created: string[] = [];
    let chain: Promise<unknown> = Promise.resolve();
    const t = {
      user: { findUnique: jest.fn(async () => ({ kycTier: 'TIER_1' })) },
      giftCardTrade: { create: jest.fn(async ({ data }: { data: { expectedNgn: string } }) => (created.push(data.expectedNgn), { id: `g${created.length}` })) },
    };
    const policy = {
      fx: jest.fn(async () => ({ ngnPerUsd: dec('1500') })),
      assertWithinLimits: jest.fn(async (_db: unknown, _u: string, _l: unknown, _a: unknown, amount: { toNumber(): number }) => {
        const used = created.reduce((s, x) => s + Number(x), 0);
        if (used + amount.toNumber() > 1_000_000) throw new BadRequestException('daily limit');
      }),
    };
    const svc = Object.create(GiftCardsService.prototype) as Record<string, unknown>;
    Object.assign(svc, {
      policy,
      box: { isConfigured: true, seal: (s: string) => s },
      notifications: { notify: jest.fn(async () => undefined) },
      prisma: {
        giftCardType: { findUnique: jest.fn(async () => ({ id: 't1', isActive: true, minAmount: '1', maxAmount: '10000', rateNgn: '1200', currency: 'USD', name: 'Card', brand: { isActive: true, name: 'Brand', category: { isActive: true } } })) },
        serializable: jest.fn((fn: (x: unknown) => Promise<unknown>) => { const run = chain.then(() => fn(t)); chain = run.catch(() => undefined); return run; }),
      },
      mine: jest.fn(async () => ({})),
    });
    const submit = () => (svc.submit as (...a: unknown[]) => Promise<unknown>).call(svc, 'u1', { typeId: 't1', faceValue: '500', code: 'ABC', images: [] });
    const results = await Promise.allSettled([submit(), submit()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(created).toEqual(['600000']);
  });
});
