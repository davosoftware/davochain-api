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
  // The stored override row, shared by the service's reads and the transaction's,
  // so a test can flip it mid-request the way an admin would.
  const row: { value: boolean | undefined } = { value: opts.override };
  const systemFlag = {
    findUnique: async ({ where }: { where: { key: string } }) =>
      where.key === NGN_WITHDRAWALS_FLAG && row.value !== undefined
        ? { key: NGN_WITHDRAWALS_FLAG, value: row.value }
        : null,
  };
  const flags = new SystemFlagsService(
    { systemFlag } as never,
    { get: (k: string) => (k === 'NGN_WITHDRAWALS_ENABLED' ? (opts.serverSetting ?? false) : undefined) } as never,
  );

  const quidax = {
    fetchBanks: jest.fn().mockResolvedValue([
      { code: '044', name: 'Access Bank', country: 'Nigeria', currency: 'NGN' },
      { code: 'GH1', name: 'Ghana Bank', country: 'Ghana', currency: 'GHS' },
    ]),
    verifyBankAccount: jest.fn().mockResolvedValue({ account_name: 'ADA OBI' }),
    createNgnBankWithdrawal: jest.fn().mockResolvedValue({ id: 'qx-1', status: 'pending' }),
    newReference: jest.fn().mockReturnValue('ngnwd-test'),
  };
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ kycTier: 'TIER_1' }) },
    serializable: jest.fn(),
  };
  const allowed = {
    allowed: true,
    singleLimit: dec(200000),
    dailyLimit: dec(500000),
    usedToday: dec(0),
    remainingToday: dec(500000),
  };
  const kycLimits = {
    check: jest.fn().mockResolvedValue(allowed),
    fx: jest.fn().mockResolvedValue({ ngnPerUsd: '1500' }),
    checkInTransaction: jest.fn().mockResolvedValue(allowed),
  };
  const feeBands = { resolve: jest.fn().mockResolvedValue(null) };
  const ledger = { lock: jest.fn().mockResolvedValue(undefined) };
  // What the payout's serializable transaction sees: the same stored switch.
  const tx = {
    systemFlag,
    user: { findUnique: jest.fn().mockResolvedValue({ kycTier: 'TIER_1' }) },
    transaction: { create: jest.fn().mockResolvedValue({ id: 'tx-1' }) },
    settlementLeg: { create: jest.fn().mockResolvedValue({}) },
  };

  const service = new WithdrawalsService(
    prisma as never,
    quidax as never,
    ledger as never,
    {} as never, // assets
    {} as never, // settlement
    {} as never, // rates
    feeBands as never,
    kycLimits as never,
    flags,
    { notify: jest.fn().mockResolvedValue(undefined) } as never,
  );
  return { service, quidax, prisma, ledger, tx, row };
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

describe('switched OFF while a payout request is already past the first check', () => {
  // The admin switches off during a provider outage while this request waits
  // on Quidax. It has no PENDING row yet, so the admin's in-progress count
  // cannot see it — the request itself must notice before any money moves.
  it('refuses inside the transaction, before any balance is locked or payout sent', async () => {
    const { service, quidax, prisma, ledger, tx, row } = build({ override: true });
    prisma.serializable.mockImplementation((fn: (t: unknown) => unknown) => fn(tx));
    quidax.verifyBankAccount.mockImplementation(async () => {
      row.value = false; // the admin's switch-off lands while Quidax is answering
      return { account_name: 'ADA OBI' };
    });

    await expect(service.withdrawNgn('user-1', { amount: '5000', ...ACCOUNT })).rejects.toThrow(
      NGN_WITHDRAWALS_OFF_MESSAGE,
    );
    expect(ledger.lock).not.toHaveBeenCalled();
    expect(tx.transaction.create).not.toHaveBeenCalled();
    expect(quidax.createNgnBankWithdrawal).not.toHaveBeenCalled();
  });
});
