import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { TxStatus } from '@prisma/client';
import { WithdrawalsService } from './withdrawals.service';
import { RailRefusedError, RailUnknownError } from '../naira-rail/naira-rail';
import { RailTransferHooks } from '../naira-rail/rail-transfer-hooks';
import { dec } from '../common/money';

/**
 * H11 (decision 19 Oct): customer naira withdrawals are paid by the naira rail
 * (Payrep today), never Quidax. Quidax is for crypto only.
 */
function build(o: { transfer?: () => Promise<unknown>; status?: unknown; resolve?: () => Promise<unknown> } = {}) {
  const rail = {
    name: 'Payrep',
    banks: jest.fn(async () => [{ code: '044', name: 'Access Bank' }]),
    resolveAccount: jest.fn(o.resolve ?? (async () => ({ accountName: 'ADA OBI' }))),
    transfer: jest.fn(o.transfer ?? (async () => ({ id: 'flw-1', reference: 'dvc_ngnwd_1', status: 'PENDING', fee: dec('10.75'), reason: null }))),
    transferStatus: jest.fn(async () => o.status ?? null),
    balance: jest.fn(),
  };
  const quidax = {
    newReference: jest.fn(() => 'dvc_ngnwd_1'),
    createNgnBankWithdrawal: jest.fn(),
    fetchBanks: jest.fn(),
    verifyBankAccount: jest.fn(),
  };
  const legUpdates: Array<Record<string, unknown>> = [];
  const txUpdates: Array<Record<string, unknown>> = [];
  const t = {
    user: { findUnique: jest.fn(async () => ({ kycTier: 'TIER_1' })) },
    transaction: { create: jest.fn(async () => ({ id: 'tx-1' })) },
    settlementLeg: { create: jest.fn(async () => ({})) },
  };
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ id: 'u1', kycTier: 'TIER_1', createdAt: new Date(0), credentialsChangedAt: null })) },
    serializable: jest.fn((fn: (x: unknown) => unknown) => fn(t)),
    transaction: { update: jest.fn(({ data }: { data: Record<string, unknown> }) => (txUpdates.push(data), {})) },
    settlementLeg: { update: jest.fn(({ data }: { data: Record<string, unknown> }) => (legUpdates.push(data), {})) },
    $transaction: jest.fn(async (ops: unknown[]) => ops),
  };
  const allowed = { allowed: true, singleLimit: dec(200000), dailyLimit: dec(500000), usedToday: dec(0), remainingToday: dec(500000), currency: 'NGN' };
  const settlement = {
    reverse: jest.fn(async () => undefined),
    markReconciling: jest.fn(async () => undefined),
    applyWithdrawalWebhook: jest.fn(async () => undefined),
  };
  const flags = {
    assertNgnWithdrawalsAllowed: jest.fn(),
    assertWithdrawalsAllowed: jest.fn(),
    assertNgnWithdrawalsAllowedIn: jest.fn(),
    ngnWithdrawalsEnabled: jest.fn(async () => true),
  };
  const hooks = new RailTransferHooks();
  const svc = new WithdrawalsService(
    prisma as never,
    quidax as never,
    { lock: jest.fn() } as never,
    {} as never,
    settlement as never,
    {} as never,
    { resolve: jest.fn(async () => null) } as never,
    { check: jest.fn(async () => allowed), checkInTransaction: jest.fn(async () => allowed), fx: async () => ({ ngnPerUsd: '1500' }) } as never,
    flags as never,
    { notify: jest.fn(async () => undefined) } as never,
    { assertCooledOff: async () => undefined } as never,
    rail as never,
    hooks,
  );
  svc.onModuleInit();
  return { svc, rail, quidax, settlement, legUpdates, txUpdates, hooks };
}

const INPUT = { amount: '5000', accountNumber: '0123456789', bankCode: '044' };

describe('Naira withdrawals are paid by the naira rail, not Quidax (H11)', () => {
  it('sends with our reference to the saved account, and never asks Quidax to pay', async () => {
    const { svc, rail, quidax, txUpdates, legUpdates } = build();
    const r = await svc.withdrawNgn('u1', INPUT, 'b1');
    expect(rail.transfer).toHaveBeenCalledWith({ reference: 'dvc_ngnwd_1', bankCode: '044', accountNumber: '0123456789', amount: dec('5000'), narration: 'DavoChain withdrawal' });
    expect(quidax.createNgnBankWithdrawal).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: TxStatus.PROCESSING });
    expect(txUpdates[0]).toMatchObject({ status: TxStatus.PROCESSING, quidaxRef: 'flw-1' });
    expect(legUpdates[0]).toMatchObject({ state: 'SENT', quidaxRef: 'flw-1' });
  });

  it('a clear refusal from the rail refunds (nothing was sent) and says so', async () => {
    const { svc, settlement } = build({ transfer: async () => { throw new RailRefusedError('Account is not valid'); } });
    await expect(svc.withdrawNgn('u1', INPUT)).rejects.toThrow(new BadRequestException('The bank refused this payout: Account is not valid. Nothing was deducted from your balance.'));
    expect(settlement.reverse).toHaveBeenCalledWith('tx-1', 'The bank refused this payout: Account is not valid');
  });

  it('an unclear answer is never refunded: it is checked instead', async () => {
    const { svc, settlement } = build({ transfer: async () => { throw new RailUnknownError('timeout'); } });
    const r = await svc.withdrawNgn('u1', INPUT);
    expect(r).toMatchObject({ status: TxStatus.RECONCILING });
    expect(settlement.reverse).not.toHaveBeenCalled();
    expect(settlement.markReconciling).toHaveBeenCalledWith('tx-1', expect.any(String), expect.stringContaining('timeout'));
  });

  it('a bank the rail cannot pay is refused before anything is locked', async () => {
    const { svc, rail } = build();
    await expect(svc.withdrawNgn('u1', { ...INPUT, bankCode: '999' })).rejects.toThrow(new BadRequestException('Choose a supported Nigerian bank'));
    expect(rail.transfer).not.toHaveBeenCalled();
  });
});

describe('Finishing a naira payout: the rail is asked by our reference', () => {
  it('SUCCESSFUL settles through the same once-only path as before', async () => {
    const { svc, settlement } = build({ status: { id: 'flw-1', reference: 'dvc_ngnwd_1', status: 'SUCCESSFUL', fee: dec('10.75'), reason: null } });
    await svc.recheckPayout('dvc_ngnwd_1');
    expect(settlement.applyWithdrawalWebhook).toHaveBeenCalledWith('withdraw.successful', expect.objectContaining({ id: 'flw-1', reference: 'dvc_ngnwd_1', fee: '10.75' }));
  });

  it('FAILED refunds through the same once-only path; pending or unknown changes nothing', async () => {
    const failed = build({ status: { id: 'flw-1', reference: 'dvc_ngnwd_1', status: 'FAILED', fee: null, reason: 'Bank declined' } });
    await failed.svc.recheckPayout('dvc_ngnwd_1');
    expect(failed.settlement.applyWithdrawalWebhook).toHaveBeenCalledWith('withdraw.rejected', expect.objectContaining({ reference: 'dvc_ngnwd_1', reason: 'Bank declined' }));
    const pending = build({ status: { id: 'flw-1', reference: 'dvc_ngnwd_1', status: 'PENDING', fee: null, reason: null } });
    await pending.svc.recheckPayout('dvc_ngnwd_1');
    expect(pending.settlement.applyWithdrawalWebhook).not.toHaveBeenCalled();
  });

  it("the rail's transfer webhook for a payout reaches this check", async () => {
    const { hooks, rail } = build();
    await hooks.dispatch('dvc_ngnwd_1');
    expect(rail.transferStatus).toHaveBeenCalledWith('dvc_ngnwd_1');
  });
});

describe('Banks and account names come from the naira rail', () => {
  it('the bank list and name checks use the rail', async () => {
    const { svc, rail, quidax } = build();
    await expect(svc.ngnBanks()).resolves.toEqual([{ code: '044', name: 'Access Bank' }]);
    await expect(svc.verifyNgnBankAccount({ accountNumber: '0123456789', bankCode: '044' })).resolves.toMatchObject({ accountName: 'ADA OBI' });
    await expect(svc.lookupNgnBankAccount({ accountNumber: '0123456789', bankCode: '044' })).resolves.toEqual({ bankName: 'Access Bank', accountName: 'ADA OBI' });
    expect(rail.resolveAccount).toHaveBeenCalled();
    expect(quidax.verifyBankAccount).not.toHaveBeenCalled();
    expect(quidax.fetchBanks).not.toHaveBeenCalled();
  });

  it('a wrong account is a 400 in plain words; the rail not answering is a 503', async () => {
    const wrong = build({ resolve: async () => { throw new RailRefusedError('Could not resolve account'); } });
    await expect(wrong.svc.verifyNgnBankAccount({ accountNumber: '0123456789', bankCode: '044' })).rejects.toThrow(
      new BadRequestException('Unable to verify those bank details. Check the account and bank.'),
    );
    const down = build({ resolve: async () => { throw new RailUnknownError('timeout'); } });
    await expect(down.svc.verifyNgnBankAccount({ accountNumber: '0123456789', bankCode: '044' })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
