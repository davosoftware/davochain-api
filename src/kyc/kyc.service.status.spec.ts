import { ZERO } from '../common/money';
import { KycService } from './kyc.service';

function setup(latest: { state: string } | null, tier = 'TIER_0') {
  const prisma = {
    kycProfile: { findUnique: jest.fn(async () => ({ tier, status: 'PENDING', documents: [] })) },
    kycTierLimit: { findMany: jest.fn(async () => []) },
    kycVerification: { findFirst: jest.fn(async () => latest) },
  };
  const check = { singleLimit: ZERO, dailyLimit: ZERO, usedToday: ZERO, remainingToday: ZERO };
  const limits = { check: jest.fn(async () => check) };
  const basic = { attemptsLeft: jest.fn(async () => ({ today: 2, total: 9 })) };
  const advanced = { summary: jest.fn(async () => ({})) };
  return new KycService(prisma as never, limits as never, basic as never, advanced as never);
}

describe('KycService.status: Basic fields (spec §11)', () => {
  it('reports the level, the latest state, a generic under-review flag and attempts left', async () => {
    const r = await setup({ state: 'COMPLIANCE_REVIEW' }).status('u1');
    expect(r).toMatchObject({ level: 'NONE', basicState: 'COMPLIANCE_REVIEW', underReview: true, attemptsLeftToday: 2, attemptsLeftTotal: 9 });
  });

  it('a Basic user is level BASIC and not under review', async () => {
    const r = await setup({ state: 'APPROVED' }, 'TIER_1').status('u1');
    expect(r).toMatchObject({ level: 'BASIC', basicState: 'APPROVED', underReview: false });
  });

  it('never says why: no AML fields leave the API', async () => {
    const r = await setup({ state: 'COMPLIANCE_REVIEW' }).status('u1');
    expect(JSON.stringify(r)).not.toMatch(/aml|sanction|pep/i);
  });
});

describe('KycService.status: Advanced (spec 2026-10-21 §4.1)', () => {
  const S = { identity: { state: 'APPROVED', reason: null, attemptsLeft: { today: 3, total: 10 } }, address: { state: 'NONE', reason: null, attemptsLeft: { today: 3, total: 10 } }, recencyMonths: 3 };
  const withAdvanced = (tier: string) => {
    const prisma = {
      kycProfile: { findUnique: jest.fn(async () => ({ tier, status: 'APPROVED', documents: [] })) },
      kycTierLimit: { findMany: jest.fn(async () => []) },
      kycVerification: { findFirst: jest.fn(async () => ({ state: 'APPROVED' })) },
    };
    const check = { singleLimit: ZERO, dailyLimit: ZERO, usedToday: ZERO, remainingToday: ZERO };
    return new KycService(prisma as never, { check: jest.fn(async () => check) } as never, { attemptsLeft: jest.fn(async () => ({ today: 2, total: 9 })) } as never, { summary: jest.fn(async () => S) } as never);
  };
  it('names the level for TIER_2 and TIER_3 and includes the advanced block', async () => {
    expect(await withAdvanced('TIER_2').status('u1')).toMatchObject({ level: 'ADVANCED_IN_PROGRESS', advanced: S });
    expect(await withAdvanced('TIER_3').status('u1')).toMatchObject({ level: 'ADVANCED' });
  });
});
