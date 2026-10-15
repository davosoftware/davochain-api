import { BadRequestException } from '@nestjs/common';
import { KycTier, PolicyAction, PolicyLevel } from '@prisma/client';
import { dec } from '../common/money';

describe('Trades obey the level rules', () => {
  it('a buy over the daily limit is refused inside the lock; nothing is locked', async () => {
    const { TradesService } = await import('./trades.service');
    const locked: string[] = [];
    const t = { user: { findUnique: jest.fn(async () => ({ kycTier: KycTier.TIER_1 })) } };
    const policy = {
      fx: jest.fn(async () => ({ ngnPerUsd: dec('1500') })),
      assertWithinLimits: jest.fn(async (_db: unknown, _u: string, level: PolicyLevel, action: PolicyAction) => {
        expect(level).toBe(PolicyLevel.BASIC);
        expect(action).toBe(PolicyAction.BUY);
        throw new BadRequestException('That would take you past your $5,000.00 daily limit to buy crypto.');
      }),
    };
    const svc = Object.create(TradesService.prototype) as Record<string, unknown>;
    Object.assign(svc, {
      policy,
      flags: { assertTradingAllowed: jest.fn(async () => undefined) },
      assets: { require: jest.fn(async () => ({ code: 'btc' })) },
      quidax: { newReference: () => 'ref' },
      ledger: { lock: jest.fn(async () => locked.push('lock')) },
      prisma: {
        inventorySetting: { findUnique: jest.fn(async () => ({ fallbackSwapEnabled: true })) },
        serializable: jest.fn((fn: (x: unknown) => unknown) => fn(t)),
      },
      settlement: { inventory: jest.fn(async () => dec('1')), mainAccount: jest.fn(async () => 'main'), quidaxIdFor: jest.fn(async () => 'sub1') },
    });
    const err = await (svc.buy as (...a: unknown[]) => Promise<unknown>).call(svc, 'u1', {
      id: 'q1', fromAsset: 'ngn', toAsset: 'btc', fromAmount: '150000', toAmount: '0.001', displayedRate: '1500',
      quidaxRate: '1500', usdValue: '100', feeUsd: null, gateApplied: '0', rateConfigId: 'cfg1',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(locked).toEqual([]);
    expect(policy.fx).toHaveBeenCalled();
  });
});
