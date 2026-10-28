import { BadRequestException } from '@nestjs/common';
import { TxStatus, TxType } from '@prisma/client';
import { PeerSendService } from './peer-send.service';
import { QuidaxError, QuidaxUnknownError } from '../quidax/quidax.errors';
import { dec } from '../common/money';

/**
 * Coins sent to an address that belongs to another DavoChain customer
 * (28 Oct 2026). Quidax moves those "internally" and the deposit side ignores
 * internal arrivals (H12), so without this the receiver was never credited.
 */
function build(opts: {
  addresses?: Array<{ userId: string; destinationTag: string | null }>;
  recipient?: { status: string; kycTier: string } | null;
  transfer?: () => Promise<unknown>;
} = {}) {
  const prisma = {
    depositAddress: { findMany: jest.fn().mockResolvedValue(opts.addresses ?? []) },
    user: { findUnique: jest.fn().mockResolvedValue(opts.recipient === undefined ? { status: 'ACTIVE', kycTier: 'TIER_1' } : opts.recipient) },
    serializable: jest.fn().mockResolvedValue({ id: 'tx-1' }),
    settlementLeg: { update: jest.fn().mockResolvedValue({}) },
  };
  const quidax = {
    newReference: jest.fn().mockReturnValue('dvc_peer_1'),
    internalTransfer: jest.fn(opts.transfer ?? (async () => ({ id: 'IW-1', status: 'done' }))),
  };
  const settlement = {
    quidaxIdFor: jest.fn(async (id: string) => `sub-${id}`),
    isUnknown: (err: unknown) => err instanceof QuidaxUnknownError,
    describe: (err: unknown) => (err as Error).message,
    internalReason: (err: unknown) => (err as Error).message,
    reverse: jest.fn().mockResolvedValue(undefined),
    markReconciling: jest.fn().mockResolvedValue(undefined),
    completePeerSend: jest.fn().mockResolvedValue(true),
  };
  const service = new PeerSendService(
    prisma as never,
    quidax as never,
    { lock: jest.fn() } as never,
    { assertTransferable: jest.fn() } as never,
    { price: jest.fn().mockResolvedValue({ priceUsd: '60000' }) } as never,
    { fx: async () => ({ ngnPerUsd: '1500' }), assertWithinLimits: async () => undefined, rulesFor: async () => [] } as never,
    settlement as never,
  );
  return { service, prisma, quidax, settlement };
}

const ASSET = { code: 'btc', displayScale: 8 } as never;
const SEND = { senderId: 'alice', recipientId: 'bob', asset: ASSET, amount: dec('0.01'), level: 'BASIC' as never };

describe('PeerSendService.recipientFor: whose address is it?', () => {
  it('an outside wallet is null: it goes on the blockchain as before', async () => {
    const { service } = build({ addresses: [] });
    await expect(service.recipientFor('alice', 'bc1qoutside')).resolves.toBeNull();
  });

  it("another verified customer's address gives that customer", async () => {
    const { service } = build({ addresses: [{ userId: 'bob', destinationTag: null }] });
    await expect(service.recipientFor('alice', 'bc1qbob')).resolves.toBe('bob');
  });

  it('matches the address whatever its capitals (0xAbC… and 0xabc… are the same wallet)', async () => {
    const { service, prisma } = build({ addresses: [{ userId: 'bob', destinationTag: null }] });
    await service.recipientFor('alice', ' 0xAbC ');
    expect(prisma.depositAddress.findMany.mock.calls[0][0].where.address).toEqual({ equals: '0xAbC', mode: 'insensitive' });
  });

  it('a shared address with tags: only the matching tag is that customer', async () => {
    const rows = [{ userId: 'bob', destinationTag: '111' }, { userId: 'carol', destinationTag: '222' }];
    await expect(build({ addresses: rows }).service.recipientFor('alice', 'rShared', '222')).resolves.toBe('carol');
    await expect(build({ addresses: rows }).service.recipientFor('alice', 'rShared')).resolves.toBeNull();
  });

  it('your own address is refused', async () => {
    const { service } = build({ addresses: [{ userId: 'alice', destinationTag: null }] });
    await expect(service.recipientFor('alice', 'bc1qalice')).rejects.toThrow(/your own DavoChain address/);
  });

  it('a receiver who has not finished Basic verification cannot receive', async () => {
    const { service } = build({ addresses: [{ userId: 'bob', destinationTag: null }], recipient: { status: 'ACTIVE', kycTier: 'TIER_0' } });
    const err = await service.recipientFor('alice', 'bc1qbob').catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'RECIPIENT_NOT_VERIFIED' });
  });

  it('a closed or suspended receiver cannot receive', async () => {
    for (const status of ['CLOSED', 'SUSPENDED']) {
      const { service } = build({ addresses: [{ userId: 'bob', destinationTag: null }], recipient: { status, kycTier: 'TIER_3' } });
      const err = await service.recipientFor('alice', 'bc1qbob').catch((e) => e);
      expect(err.getResponse()).toMatchObject({ code: 'RECIPIENT_CANNOT_RECEIVE' });
    }
  });
});

describe('PeerSendService.send: moved inside DavoChain, free', () => {
  it("moves the coins from the sender's Quidax account to the receiver's and completes", async () => {
    const { service, quidax, settlement } = build();
    const r = await service.send(SEND);
    expect(quidax.internalTransfer).toHaveBeenCalledWith('sub-alice', { currency: 'btc', amount: '0.01', fund_uid: 'sub-bob', reference: 'dvc_peer_1' });
    expect(settlement.completePeerSend).toHaveBeenCalledWith('tx-1', 'IW-1');
    expect(r).toMatchObject({ transactionId: 'tx-1', status: TxStatus.COMPLETED, amount: '0.01000000', toDavoChainCustomer: true });
  });

  it('records no fee at all: DavoChain to DavoChain is free', async () => {
    const { service, prisma } = build();
    const create = jest.fn().mockResolvedValue({ id: 'tx-1' });
    prisma.serializable.mockImplementation(async (fn: (t: unknown) => unknown) =>
      fn({ transaction: { create }, settlementLeg: { create: jest.fn() } }),
    );
    await service.send(SEND);
    expect(create.mock.calls[0][0].data).toMatchObject({ type: TxType.WITHDRAWAL, peerUserId: 'bob', feeAmount: '0', networkFee: '0', fromAmount: '0.01' });
  });

  it('Quidax definitely refuses: the sender gets it back and is told', async () => {
    const { service, settlement } = build({ transfer: async () => { throw new QuidaxError('Insufficient balance', null, 422); } });
    await expect(service.send(SEND)).rejects.toBeInstanceOf(BadRequestException);
    expect(settlement.reverse).toHaveBeenCalledWith('tx-1', 'Insufficient balance');
    expect(settlement.completePeerSend).not.toHaveBeenCalled();
  });

  it('outcome unknown: nothing refunded, nothing credited, checked later', async () => {
    const { service, settlement } = build({ transfer: async () => { throw new QuidaxUnknownError('timeout', 'POST', '/x', 'dvc_peer_1'); } });
    const r = await service.send(SEND);
    expect(r.status).toBe(TxStatus.RECONCILING);
    expect(settlement.reverse).not.toHaveBeenCalled();
    expect(settlement.completePeerSend).not.toHaveBeenCalled();
  });
});
