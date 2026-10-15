import { BadRequestException } from '@nestjs/common';
import { TxStatus } from '@prisma/client';
import { WithdrawalsService } from './withdrawals.service';
import { QuidaxError, QuidaxUnknownError } from '../quidax/quidax.errors';
import { dec } from '../common/money';

/**
 * C3 (PROJECT_REVIEW): once Quidax has accepted a crypto withdrawal, the coins
 * are on their way. A failure in OUR database afterwards must never refund the
 * user. Only a definite rejection from Quidax may.
 */
function build(opts: { send?: () => Promise<unknown>; dbFailsAfterSend?: boolean } = {}) {
  const quidax = {
    newReference: jest.fn().mockReturnValue('wd-test'),
    createCryptoWithdrawal: jest.fn(opts.send ?? (async () => ({ id: 'qx-wd-1', status: 'Submitted', fee: '0.0001' }))),
  };
  const settlement = {
    quidaxIdFor: jest.fn().mockResolvedValue('sub-1'),
    isUnknown: (err: unknown) => err instanceof QuidaxUnknownError,
    describe: (err: unknown) => (err as Error).message,
    reverse: jest.fn().mockResolvedValue(undefined),
    markReconciling: jest.fn().mockResolvedValue(undefined),
  };
  const dbDown = () => Promise.reject(new Error('connection terminated'));
  const prisma = {
    assetNetwork: { findUnique: jest.fn().mockResolvedValue({ isListed: true, withdrawsEnabled: true, requiresTag: false, addressRegex: null, label: 'Bitcoin' }) },
    serializable: jest.fn().mockResolvedValue({ id: 'tx-1' }),
    transaction: { update: jest.fn(opts.dbFailsAfterSend ? dbDown : async () => ({})) },
    settlementLeg: { update: jest.fn(opts.dbFailsAfterSend ? dbDown : async () => ({})) },
  };
  const service = new WithdrawalsService(
    prisma as never,
    quidax as never,
    { lock: jest.fn() } as never,
    { require: jest.fn().mockResolvedValue({ code: 'btc', displayScale: 8 }) } as never,
    settlement as never,
    { rateConfig: jest.fn().mockResolvedValue({ id: 'cfg-1' }) } as never,
    {} as never,
    {} as never,
    { assertWithdrawalsAllowed: jest.fn().mockResolvedValue(undefined) } as never,
    { notify: jest.fn() } as never,
  );
  jest
    .spyOn(service as unknown as { fees: () => Promise<unknown> }, 'fees')
    .mockResolvedValue({ platformFee: dec('0.0001'), platformFeeUsd: null, networkFee: dec('0.0001'), usdValue: null });
  return { service, settlement, quidax };
}

const INPUT = { asset: 'btc', network: 'btc', amount: '0.01', address: 'bc1qexampleaddress' };

describe('C3: a crypto withdrawal is never refunded after Quidax accepted it', () => {
  it('normal case: accepted and recorded, status PROCESSING', async () => {
    const { service, settlement } = build();
    const result = await service.withdrawCrypto('u1', INPUT);
    expect(result.status).toBe(TxStatus.PROCESSING);
    expect(settlement.reverse).not.toHaveBeenCalled();
  });

  it('our database fails after Quidax accepted: funds stay locked, marked RECONCILING, no refund', async () => {
    const { service, settlement } = build({ dbFailsAfterSend: true });
    const result = await service.withdrawCrypto('u1', INPUT);
    expect(settlement.reverse).not.toHaveBeenCalled();
    expect(settlement.markReconciling).toHaveBeenCalled();
    expect(result.status).toBe(TxStatus.RECONCILING);
  });

  it('Quidax definitely refuses: the user is refunded', async () => {
    const { service, settlement } = build({ send: async () => { throw new QuidaxError('Insufficient balance', null, 422); } });
    await expect(service.withdrawCrypto('u1', INPUT)).rejects.toBeInstanceOf(BadRequestException);
    expect(settlement.reverse).toHaveBeenCalled();
  });

  it('Quidax outcome unknown: no refund, RECONCILING', async () => {
    const { service, settlement } = build({ send: async () => { throw new QuidaxUnknownError('timeout', 'POST', '/x', 'wd-test'); } });
    const result = await service.withdrawCrypto('u1', INPUT);
    expect(settlement.reverse).not.toHaveBeenCalled();
    expect(result.status).toBe(TxStatus.RECONCILING);
  });
});
