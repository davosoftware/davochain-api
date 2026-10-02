import { ForbiddenException } from '@nestjs/common';
import { WithdrawalsService } from './withdrawals.service';
import {
  NGN_WITHDRAWALS_FLAG,
  NGN_WITHDRAWALS_OFF_MESSAGE,
  SystemFlagsService,
} from '../common/system-flags.service';
import { dec } from '../common/money';

/**
 * The naira routes obey the switch, proved with the real SystemFlagsService
 * over an in-memory override row and a server setting, so it is the stored
 * switch that decides, not a stub of it.
 */
function build(opts: { override?: boolean; serverSetting?: boolean } = {}) {
  const flags = new SystemFlagsService(
    {
      systemFlag: {
        findUnique: async () =>
          opts.override === undefined ? null : { key: NGN_WITHDRAWALS_FLAG, value: opts.override },
      },
    } as never,
    { get: (k: string) => (k === 'NGN_WITHDRAWALS_ENABLED' ? (opts.serverSetting ?? false) : undefined) } as never,
  );

  const quidax = {
    fetchBanks: jest.fn().mockResolvedValue([
      { code: '044', name: 'Access Bank', country: 'Nigeria', currency: 'NGN' },
      { code: 'GH1', name: 'Ghana Bank', country: 'Ghana', currency: 'GHS' },
    ]),
    verifyBankAccount: jest.fn().mockResolvedValue({ account_name: 'ADA OBI' }),
    createNgnBankWithdrawal: jest.fn(),
  };
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ kycTier: 'TIER_1' }) },
    serializable: jest.fn(),
  };
  const kycLimits = {
    check: jest.fn().mockResolvedValue({
      allowed: true,
      singleLimit: dec(200000),
      dailyLimit: dec(500000),
      usedToday: dec(0),
      remainingToday: dec(500000),
    }),
  };
  const feeBands = { resolve: jest.fn().mockResolvedValue(null) };

  const service = new WithdrawalsService(
    prisma as never,
    quidax as never,
    {} as never, // ledger
    {} as never, // assets
    {} as never, // settlement
    {} as never, // rates
    feeBands as never,
    kycLimits as never,
    flags,
    { notify: jest.fn() } as never,
  );
  return { service, quidax, prisma };
}

const ACCOUNT = { accountNumber: '0123456789', bankCode: '044' };

describe('naira withdrawals switched OFF', () => {
  it('refuses the bank list and never asks Quidax', async () => {
    const { service, quidax } = build();
    await expect(service.ngnBanks()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.ngnBanks()).rejects.toThrow(NGN_WITHDRAWALS_OFF_MESSAGE);
    expect(quidax.fetchBanks).not.toHaveBeenCalled();
  });

  it('refuses account verification and never asks Quidax', async () => {
    const { service, quidax } = build();
    await expect(service.verifyNgnBankAccount(ACCOUNT)).rejects.toThrow(NGN_WITHDRAWALS_OFF_MESSAGE);
    expect(quidax.verifyBankAccount).not.toHaveBeenCalled();
  });

  it('refuses a payout before any money is locked or sent', async () => {
    const { service, quidax, prisma } = build();
    await expect(service.withdrawNgn('user-1', { amount: '5000', ...ACCOUNT })).rejects.toThrow(
      NGN_WITHDRAWALS_OFF_MESSAGE,
    );
    expect(prisma.serializable).not.toHaveBeenCalled();
    expect(quidax.verifyBankAccount).not.toHaveBeenCalled();
    expect(quidax.createNgnBankWithdrawal).not.toHaveBeenCalled();
  });

  it('still prices the fee, and tells the app payouts are unavailable', async () => {
    const quote = await build().service.quoteNgnWithdrawalFee('user-1', '5000');
    expect(quote.payoutAvailable).toBe(false);
    expect(quote.amount).toBe('5000.00');
  });
});

describe('naira withdrawals switched ON', () => {
  it('the server setting alone turns them on', async () => {
    const { service } = build({ serverSetting: true });
    expect(await service.ngnBanks()).toEqual([{ code: '044', name: 'Access Bank' }]);
    expect((await service.quoteNgnWithdrawalFee('user-1', '5000')).payoutAvailable).toBe(true);
  });

  it('an admin override turns them on over a server setting that is off', async () => {
    const { service } = build({ override: true, serverSetting: false });
    expect(await service.ngnBanks()).toEqual([{ code: '044', name: 'Access Bank' }]);
  });

  it('an admin override switches them off over a server setting that is on', async () => {
    const { service } = build({ override: false, serverSetting: true });
    await expect(service.ngnBanks()).rejects.toThrow(NGN_WITHDRAWALS_OFF_MESSAGE);
  });
});
