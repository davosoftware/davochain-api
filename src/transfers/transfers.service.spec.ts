import { TransfersService } from './transfers.service';
import { PayUsernamesService } from './pay-usernames.service';

/** POST /v1/transfers/crypto: send to a DavoChain customer by username (28 Oct 2026). */
function build(opts: { recipient?: Record<string, unknown> | null; isFiat?: boolean } = {}) {
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id
          ? { id: 'alice', kycTier: 'TIER_1', createdAt: new Date(0), credentialsChangedAt: null }
          : opts.recipient === undefined
            ? { id: 'bob', firstName: 'Bob', lastName: 'Eze', status: 'ACTIVE', kycTier: 'TIER_1', payUsername: 'bob_eze_1' }
            : opts.recipient,
      ),
    },
  };
  const peers = {
    assertCanReceive: jest.fn(async () => undefined),
    send: jest.fn(async () => ({ transactionId: 'tx-1', status: 'COMPLETED', asset: 'usdt', amount: '5.000000', toDavoChainCustomer: true })),
  };
  const service = new TransfersService(
    prisma as never,
    { require: jest.fn(async () => ({ code: 'usdt', isFiat: opts.isFiat ?? false, displayScale: 6 })) } as never,
    { assertCooledOff: jest.fn(async () => undefined) } as never,
    { assertWithdrawalsAllowed: jest.fn(async () => undefined) } as never,
    new PayUsernamesService(prisma as never),
    peers as never,
  );
  return { service, peers };
}

describe('TransfersService.sendByUsername', () => {
  it('sends through the same engine as an address send, and says to whom', async () => {
    const { service, peers } = build();
    const r = await service.sendByUsername('alice', { username: '@Bob_Eze_1', asset: 'USDT', amount: '5' });
    expect(peers.assertCanReceive).toHaveBeenCalledWith('alice', 'bob');
    expect(peers.send).toHaveBeenCalledWith(expect.objectContaining({ senderId: 'alice', recipientId: 'bob', level: 'BASIC' }));
    expect(r).toMatchObject({ transactionId: 'tx-1', status: 'COMPLETED', to: { username: 'bob_eze_1', displayName: 'Bob E.' } });
  });

  it('an unknown username is 404 USERNAME_NOT_FOUND', async () => {
    const err = await build({ recipient: null }).service.sendByUsername('alice', { username: 'nobody_here', asset: 'usdt', amount: '5' }).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'USERNAME_NOT_FOUND' });
  });

  it('naira cannot be sent by username', async () => {
    const err = await build({ isFiat: true }).service.sendByUsername('alice', { username: 'bob_eze_1', asset: 'ngn', amount: '5' }).catch((e) => e);
    expect(err.getStatus()).toBe(400);
  });

  it.each(['0', '-1', 'abc', ''])('amount %p is refused', async (amount) => {
    const err = await build().service.sendByUsername('alice', { username: 'bob_eze_1', asset: 'usdt', amount }).catch((e) => e);
    expect(err.getStatus()).toBe(400);
  });

  it('a large first send to someone needs no password now: the PIN on the route replaced it (29 Oct 2026)', async () => {
    const { service, peers } = build();
    await service.sendByUsername('alice', { username: 'bob_eze_1', asset: 'usdt', amount: '70' });
    expect(peers.send).toHaveBeenCalled();
  });
});
