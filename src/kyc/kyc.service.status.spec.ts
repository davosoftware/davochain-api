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
  return new KycService(prisma as never, limits as never, basic as never);
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
