import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { WithdrawalsService } from './withdrawals.service';
import { QuidaxError } from '../quidax/quidax.errors';
import { dec } from '../common/money';

/**
 * Submitting a naira withdrawal (8.7) re-checks the bank account. A refusal
 * from Quidax used to escape as a 500; it must answer exactly like 8.6 does,
 * and nothing may be locked or sent.
 */
function build(verify: () => Promise<unknown>) {
  const quidax = {
    verifyBankAccount: jest.fn(verify),
    fetchBanks: jest.fn().mockResolvedValue([{ code: '044', name: 'Access Bank', country: 'Nigeria', currency: 'NGN' }]),
    createNgnBankWithdrawal: jest.fn(),
    newReference: jest.fn().mockReturnValue('ngnwd-test'),
  };
  const allowed = { allowed: true, singleLimit: dec(200000), dailyLimit: dec(500000), usedToday: dec(0), remainingToday: dec(500000) };
  const prisma = { user: { findUnique: jest.fn().mockResolvedValue({ kycTier: 'TIER_1' }) }, serializable: jest.fn() };
  const flags = {
    assertNgnWithdrawalsAllowed: jest.fn().mockResolvedValue(undefined),
    assertWithdrawalsAllowed: jest.fn().mockResolvedValue(undefined),
    ngnWithdrawals: jest.fn().mockResolvedValue({ enabled: true }),
    ngnWithdrawalsEnabled: jest.fn().mockResolvedValue(true),
  };
  const service = new WithdrawalsService(
    prisma as never,
    quidax as never,
    { lock: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    { resolve: jest.fn().mockResolvedValue(null) } as never,
    { check: jest.fn().mockResolvedValue(allowed), checkInTransaction: jest.fn().mockResolvedValue(allowed) } as never,
    flags as never,
    { notify: jest.fn() } as never,
    { fx: async () => ({ ngnPerUsd: '1500' }), assertCooledOff: async () => undefined, assertWithinLimits: async () => undefined, rulesFor: async () => [] } as never, // policy
  );
  return { service, quidax, prisma };
}

const INPUT = { amount: '5000', accountNumber: '0123456789', bankCode: '044' };

describe('naira withdrawal submit (8.7): bank details refused at submit time', () => {
  it('a 4xx from Quidax is a 400 with the same words as 8.6, and nothing is locked', async () => {
    const { service, prisma, quidax } = build(async () => {
      throw new QuidaxError('account not found', null, 422);
    });
    const err = await service.withdrawNgn('user-1', INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Unable to verify those bank details. Check the account and bank.');
    expect(prisma.serializable).not.toHaveBeenCalled();
    expect(quidax.createNgnBankWithdrawal).not.toHaveBeenCalled();
  });

  it('Quidax unreachable is a 503, not a 500, and nothing is locked', async () => {
    const { service, prisma } = build(async () => {
      throw new Error('socket hang up');
    });
    const err = await service.withdrawNgn('user-1', INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.serializable).not.toHaveBeenCalled();
  });

  it('the bank list failing is a 503, not a 500', async () => {
    const { service, quidax, prisma } = build(async () => ({ account_name: 'ADA OBI' }));
    quidax.fetchBanks.mockRejectedValueOnce(new Error('timeout'));
    const err = await service.withdrawNgn('user-1', INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.serializable).not.toHaveBeenCalled();
  });
});
