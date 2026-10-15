import { KycTier, PolicyAction, PolicyLevel } from '@prisma/client';
import { ACTIONS, LEVEL_NAMES, levelOf, lowestLevelAllowing, tierFor } from './levels';

describe('levels', () => {
  it('maps tiers to the three rule columns; Advanced (in progress) uses Basic', () => {
    expect(levelOf(KycTier.TIER_0)).toBe(PolicyLevel.NONE);
    expect(levelOf(KycTier.TIER_1)).toBe(PolicyLevel.BASIC);
    expect(levelOf(KycTier.TIER_2)).toBe(PolicyLevel.BASIC);
    expect(levelOf(KycTier.TIER_3)).toBe(PolicyLevel.ADVANCED);
  });

  it('names every tier the way people read it', () => {
    expect(LEVEL_NAMES).toEqual({ TIER_0: 'None', TIER_1: 'Basic', TIER_2: 'Advanced (in progress)', TIER_3: 'Advanced' });
  });

  it('gives each level the tier the old app field expects', () => {
    expect(tierFor(PolicyLevel.NONE)).toBe(KycTier.TIER_0);
    expect(tierFor(PolicyLevel.BASIC)).toBe(KycTier.TIER_1);
    expect(tierFor(PolicyLevel.ADVANCED)).toBe(KycTier.TIER_3);
  });

  it('knows every action, its unit, and which ones cool off', () => {
    expect(Object.keys(ACTIONS).sort()).toEqual(Object.values(PolicyAction).sort());
    expect(ACTIONS.GIFTCARD_SELL.unit).toBe('NGN');
    expect(ACTIONS.BUY.unit).toBe('USD');
    expect(ACTIONS.NGN_DEPOSIT.incoming).toBe(true);
    expect(ACTIONS.CRYPTO_WITHDRAW.coolsOff && ACTIONS.NGN_WITHDRAW.coolsOff).toBe(true);
    expect(ACTIONS.BUY.coolsOff).toBe(false);
  });

  it('finds the lowest level that allows an action, or null', () => {
    const rules = [
      { level: PolicyLevel.NONE, action: PolicyAction.GIFTCARD_SELL, allowed: false },
      { level: PolicyLevel.BASIC, action: PolicyAction.GIFTCARD_SELL, allowed: false },
      { level: PolicyLevel.ADVANCED, action: PolicyAction.GIFTCARD_SELL, allowed: true },
    ];
    expect(lowestLevelAllowing(rules, PolicyAction.GIFTCARD_SELL)).toBe(PolicyLevel.ADVANCED);
    expect(lowestLevelAllowing(rules.map((r) => ({ ...r, allowed: false })), PolicyAction.GIFTCARD_SELL)).toBeNull();
  });
});
