import { KycTier, PolicyAction, PolicyLevel } from '@prisma/client';
import { KycLimitsService } from './kyc-limits.service';
import { dec } from '../common/money';

describe('KycLimitsService reads the level rules (spec §5.3)', () => {
  function build(verdict: Record<string, unknown>) {
    const policy = {
      fx: jest.fn(async () => ({ ngnPerUsd: dec('1500') })),
      evaluate: jest.fn(async () => ({ currency: 'NGN', usedToday: dec('0'), minPerTx: null, ...verdict })),
    };
    return { svc: new KycLimitsService({} as never, policy as never), policy };
  }

  it('maps a withdrawal to NGN_WITHDRAW at the person\'s level, in naira', async () => {
    const { svc, policy } = build({ allowed: true, maxPerTx: dec('100000'), maxPerDay: dec('500000'), remainingToday: dec('500000') });
    const r = await svc.check('u1', KycTier.TIER_2, 'withdraw', dec('5000'));
    expect(policy.evaluate).toHaveBeenCalledWith(expect.anything(), 'u1', PolicyLevel.BASIC, PolicyAction.NGN_WITHDRAW, dec('5000'), 'NGN', expect.anything(), expect.anything());
    expect(r).toMatchObject({ allowed: true, singleLimit: dec('100000'), dailyLimit: dec('500000') });
  });

  it('"no limit" stays null rather than becoming zero', async () => {
    const { svc } = build({ allowed: true, maxPerTx: null, maxPerDay: null, remainingToday: null });
    const r = await svc.check('u1', KycTier.TIER_1, 'deposit', dec('5000'));
    expect(r.singleLimit).toBeNull();
    expect(r.dailyLimit).toBeNull();
  });

  it('a released held deposit is left out of its own daily total', async () => {
    const { svc, policy } = build({ allowed: true, maxPerTx: null, maxPerDay: dec('1'), remainingToday: dec('1') });
    await svc.check('u1', KycTier.TIER_1, 'deposit', dec('1'), new Date(), 'tx-held');
    expect(policy.evaluate).toHaveBeenCalledWith(expect.anything(), 'u1', PolicyLevel.BASIC, PolicyAction.NGN_DEPOSIT, dec('1'), 'NGN', expect.anything(), expect.objectContaining({ excludeTransactionId: 'tx-held' }));
  });
});
