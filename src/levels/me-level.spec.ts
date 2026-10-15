import { KycTier, PolicyAction, PolicyLevel } from '@prisma/client';
import { LevelPolicyService } from './level-policy.service';
import { dec } from '../common/money';

const NOW = new Date('2026-10-15T10:00:00Z');

function build(user: { kycTier: KycTier; kycStatus?: string; amlStatus?: string; createdAt: Date; credentialsChangedAt: Date | null }) {
  const rules = [
    { level: PolicyLevel.BASIC, action: PolicyAction.GIFTCARD_SELL, allowed: true, currency: 'NGN', minPerTx: dec('5000'), maxPerTx: dec('500000'), maxPerDay: dec('1000000') },
    { level: PolicyLevel.BASIC, action: PolicyAction.BUY, allowed: true, currency: 'USD', minPerTx: null, maxPerTx: null, maxPerDay: dec('5000') },
  ];
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ id: 'u1', kycStatus: 'APPROVED', amlStatus: 'CLEAR', ...user })) },
    levelRule: {
      findMany: jest.fn(async ({ where }: { where: { level?: string; action?: string } }) =>
        rules.filter((r) => (!where?.level || r.level === where.level) && (!where?.action || r.action === where.action))),
    },
    levelCooloff: { findUnique: jest.fn(async () => ({ afterSignupHours: 24, afterCredentialChangeHours: 48, afterNewPayeeHours: 0 })) },
    transaction: { aggregate: jest.fn(async () => ({ _sum: { usdValue: dec('0'), toAmount: dec('0') } })) },
    giftCardTrade: { aggregate: jest.fn(async () => ({ _sum: { expectedNgn: dec('0') } })) },
    platformLimit: { findUnique: jest.fn(async () => null) },
  };
  const rates = { price: jest.fn(async () => ({ ngnPerUsd: dec('1500') })) };
  return new LevelPolicyService(prisma as never, rates as never);
}

describe('GET /v1/me/level: what this person may do, and what is left today', () => {
  it('Advanced (in progress) shows Basic rules, every action, null for "no limit"', async () => {
    const svc = build({ kycTier: KycTier.TIER_2, createdAt: new Date('2026-01-01T00:00:00Z'), credentialsChangedAt: null });
    const s = await svc.snapshotFor('u1', NOW);
    expect(s).toMatchObject({ level: 'BASIC', levelName: 'Advanced (in progress)', tier: 'TIER_2', advancedInProgress: true });
    expect(s.actions).toHaveLength(Object.keys(PolicyAction).length);
    // Allowed even though 0 is below the minimum: "allowed" is the rule, not a test amount.
    expect(s.actions.find((a) => a.action === 'GIFTCARD_SELL')).toMatchObject({
      label: 'sell gift cards', allowed: true, currency: 'NGN', minPerTx: '5000.00', maxPerTx: '500000.00', maxPerDay: '1000000.00', usedToday: '0.00', remainingToday: '1000000.00',
    });
    expect(s.actions.find((a) => a.action === 'BUY')).toMatchObject({ allowed: true, currency: 'USD', minPerTx: null, maxPerTx: null, maxPerDay: '5000.00' });
    expect(s.actions.find((a) => a.action === 'SWAP')).toMatchObject({ allowed: false });
    expect(s.cooloffs.withdrawalsOpenAt).toBeNull();
  });

  it('withdrawalsOpenAt is the later of the two cool-off ends', async () => {
    const svc = build({ kycTier: KycTier.TIER_1, createdAt: new Date('2026-10-15T00:00:00Z'), credentialsChangedAt: new Date('2026-10-15T09:00:00Z') });
    const s = await svc.snapshotFor('u1', NOW);
    expect(s.cooloffs.withdrawalsOpenAt).toBe('2026-10-17T09:00:00.000Z');
  });
});
