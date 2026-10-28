import { railFromQuidax } from './testing/rail-from-quidax';
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
function build(opts: { send?: () => Promise<unknown>; dbFailsAfterSend?: boolean; peer?: string | null } = {}) {
  const quidax = {
    newReference: jest.fn().mockReturnValue('wd-test'),
    createCryptoWithdrawal: jest.fn(opts.send ?? (async () => ({ id: 'qx-wd-1', status: 'Submitted', fee: '0.0001' }))),
  };
  const settlement = {
    quidaxIdFor: jest.fn().mockResolvedValue('sub-1'),
    isUnknown: (err: unknown) => err instanceof QuidaxUnknownError,
    describe: (err: unknown) => (err as Error).message,
    internalReason: (err: unknown) => (err as Error).message,
    reverse: jest.fn().mockResolvedValue(undefined),
    markReconciling: jest.fn().mockResolvedValue(undefined),
  };
  const peers = {
    recipientFor: jest.fn().mockResolvedValue(opts.peer ?? null),
    send: jest.fn().mockResolvedValue({ transactionId: 'tx-peer', status: TxStatus.COMPLETED }),
  };
  const dbDown = () => Promise.reject(new Error('connection terminated'));
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-1', kycTier: 'TIER_1', createdAt: new Date(0), credentialsChangedAt: null }) },
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
    { fx: async () => ({ ngnPerUsd: '1500' }), assertCooledOff: async () => undefined, assertWithinLimits: async () => undefined, rulesFor: async () => [] } as never, // policy
    railFromQuidax(quidax as never) as never, // naira rail
    undefined, // rail hooks
    peers as never,
  );
  jest
    .spyOn(service as unknown as { fees: () => Promise<unknown> }, 'fees')
    .mockResolvedValue({ platformFee: dec('0.0001'), platformFeeUsd: null, networkFee: dec('0.0001'), usdValue: null });
  return { service, settlement, quidax, peers };
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
    // M5: the customer reads a plain reason; the database error goes to the log only.
    expect(settlement.markReconciling).toHaveBeenCalledWith('tx-1', 'Being checked — awaiting confirmation', expect.stringContaining('connection terminated'));
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

describe("an address that belongs to another DavoChain customer", () => {
  it('goes inside DavoChain, free, and never to the blockchain', async () => {
    const { service, quidax, peers } = build({ peer: 'bob' });
    const r = await service.withdrawCrypto('u1', INPUT, 'saved-1');
    expect(quidax.createCryptoWithdrawal).not.toHaveBeenCalled();
    expect(peers.send).toHaveBeenCalledWith(expect.objectContaining({ senderId: 'u1', recipientId: 'bob', savedCryptoAddressId: 'saved-1', level: 'BASIC' }));
    expect(peers.send.mock.calls[0][0].amount.toString()).toBe('0.01');
    expect(r).toMatchObject({ transactionId: 'tx-peer', status: TxStatus.COMPLETED, address: INPUT.address });
  });

  it('an outside address still goes to the blockchain', async () => {
    const { service, quidax, peers } = build({ peer: null });
    await service.withdrawCrypto('u1', INPUT);
    expect(peers.recipientFor).toHaveBeenCalledWith('u1', INPUT.address, undefined);
    expect(quidax.createCryptoWithdrawal).toHaveBeenCalled();
  });
});

describe('the fee quote knows a DavoChain address', () => {
  it('a saved address of another DavoChain customer: no fees at all', async () => {
    const { service, quidax } = build({ peer: 'bob' });
    (service as any).prisma.savedCryptoAddress = { findFirst: jest.fn(async () => ({ id: 'saved-1', address: 'bc1qbob', destinationTag: null })) };
    (quidax as any).fetchWithdrawalFee = jest.fn();
    const q = await service.quoteFee('btc', '0.01', 'btc', { userId: 'u1', savedCryptoAddressId: 'saved-1' });
    expect(q).toMatchObject({ networkFee: '0.00000000', platformFee: '0.00000000', totalFee: '0.00000000', totalDeducted: '0.01000000', youReceive: '0.01000000', toDavoChainCustomer: true });
    expect((quidax as any).fetchWithdrawalFee).not.toHaveBeenCalled();
  });
});

describe('withdrawal history names the DavoChain customer it went to', () => {
  it('to: { username, displayName } on a send to a customer, null otherwise', async () => {
    const { service } = build();
    const at = new Date();
    (service as any).prisma.transaction.findMany = jest.fn(async () => [
      { id: 'w1', fromAsset: 'usdt', toAmount: dec('5'), fromAmount: dec('5'), feeAmount: dec('0'), networkFee: dec('0'), peerUserId: 'bob', status: 'COMPLETED', createdAt: at, completedAt: at },
      { id: 'w2', fromAsset: 'usdt', toAmount: dec('5'), fromAmount: dec('6'), feeAmount: dec('1'), networkFee: dec('0'), peerUserId: null, status: 'COMPLETED', createdAt: at, completedAt: at },
    ]);
    (service as any).prisma.user.findMany = jest.fn(async () => [{ id: 'bob', firstName: 'Bob', lastName: 'Eze', payUsername: null }]);
    const [toBob, outside] = await service.history('u1');
    expect(toBob.to).toEqual({ username: null, displayName: 'Bob E.' });
    expect(outside.to).toBeNull();
  });
});
