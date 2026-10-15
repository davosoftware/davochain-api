import { KycTier, LevelRule, PolicyAction, PolicyLevel } from '@prisma/client';

/** The rule column a person's tier uses. Advanced (in progress) has Basic's rules (spec D1). */
export function levelOf(tier: KycTier): PolicyLevel {
  if (tier === KycTier.TIER_3) return PolicyLevel.ADVANCED;
  if (tier === KycTier.TIER_1 || tier === KycTier.TIER_2) return PolicyLevel.BASIC;
  return PolicyLevel.NONE;
}

/** The tier the current app reads in `requiredTier`, for a level. */
export function tierFor(level: PolicyLevel): KycTier {
  return level === PolicyLevel.ADVANCED ? KycTier.TIER_3 : level === PolicyLevel.BASIC ? KycTier.TIER_1 : KycTier.TIER_0;
}

/** How a tier is shown. "Tier N" is never shown to anyone (spec §3). */
export const LEVEL_NAMES: Record<KycTier, string> = {
  TIER_0: 'None',
  TIER_1: 'Basic',
  TIER_2: 'Advanced (in progress)',
  TIER_3: 'Advanced',
};

export const LEVEL_TITLES: Record<PolicyLevel, string> = { NONE: 'None', BASIC: 'Basic', ADVANCED: 'Advanced' };

/**
 * The only list in code (spec §4.1): each action IS code. Everything about it
 * (on/off, limits, currency) is admin data. `unit` is the currency its amounts
 * naturally come in; `coolsOff` marks the withdrawals the cool-offs apply to.
 */
export const ACTIONS: Record<PolicyAction, { label: string; unit: 'NGN' | 'USD'; incoming: boolean; coolsOff: boolean }> = {
  BUY: { label: 'buy crypto', unit: 'USD', incoming: false, coolsOff: false },
  SELL: { label: 'sell crypto', unit: 'USD', incoming: false, coolsOff: false },
  SWAP: { label: 'swap crypto', unit: 'USD', incoming: false, coolsOff: false },
  CRYPTO_DEPOSIT: { label: 'receive crypto', unit: 'USD', incoming: true, coolsOff: false },
  CRYPTO_WITHDRAW: { label: 'withdraw crypto', unit: 'USD', incoming: false, coolsOff: true },
  NGN_DEPOSIT: { label: 'deposit naira', unit: 'NGN', incoming: true, coolsOff: false },
  NGN_WITHDRAW: { label: 'withdraw naira', unit: 'NGN', incoming: false, coolsOff: true },
  GIFTCARD_SELL: { label: 'sell gift cards', unit: 'NGN', incoming: false, coolsOff: false },
};

const ORDER: PolicyLevel[] = [PolicyLevel.NONE, PolicyLevel.BASIC, PolicyLevel.ADVANCED];

/** The lowest level whose rule allows the action, or null when none does. */
export function lowestLevelAllowing(
  rules: Pick<LevelRule, 'level' | 'action' | 'allowed'>[],
  action: PolicyAction,
): PolicyLevel | null {
  for (const level of ORDER) {
    if (rules.some((r) => r.level === level && r.action === action && r.allowed)) return level;
  }
  return null;
}
