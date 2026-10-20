import { QuidaxEventConfirmer } from './quidax-event-confirmer';
import { QuidaxError } from '../quidax/quidax.errors';

/**
 * OPEN_ISSUES A1: a Quidax message is never acted on by itself. The deposit,
 * withdrawal or swap it names is fetched from Quidax, and only Quidax's own
 * answer is used. A forged message (our webhook secret leaked) can then
 * neither create money nor refund money that was sent.
 */
const notFound = () => new QuidaxError('Not found', null, 404);

function setup(over: {
  deposit?: unknown;
  withdrawal?: unknown;
  swaps?: unknown[];
  tx?: { type: string; userId: string } | null;
  leg?: { transaction: { type: string; userId: string } } | null;
} = {}) {
  const quidax = {
    fetchDeposit: jest.fn(async () => {
      if (over.deposit instanceof Error) throw over.deposit;
      return over.deposit;
    }),
    fetchWithdrawalByReference: jest.fn(async () => {
      if (over.withdrawal instanceof Error) throw over.withdrawal;
      return over.withdrawal ?? null;
    }),
    fetchSwapTransactions: jest.fn(async () => over.swaps ?? []),
  };
  const prisma = {
    quidaxAccount: { findUnique: jest.fn(async () => ({ quidaxUserId: 'sub-1' })) },
    transaction: { findFirst: jest.fn(async () => (over.tx === undefined ? { type: 'WITHDRAWAL', userId: 'u1' } : over.tx)) },
    settlementLeg: { findFirst: jest.fn(async () => (over.leg === undefined ? { transaction: { type: 'SWAP', userId: 'u1' } } : over.leg)) },
  };
  const provisioning = { findUserByQuidax: jest.fn(async () => 'u1') };
  const settlement = { quidaxIdFor: jest.fn(async () => 'sub-1') };
  const c = new QuidaxEventConfirmer(prisma as never, quidax as never, provisioning as never, settlement as never);
  return { c, quidax };
}

const message = { id: 'dep-1', currency: 'usdt', amount: '1000000', status: 'accepted', user: { id: 'sub-1', sn: 'SN1' } };

describe('Deposits: credited only on what Quidax itself says', () => {
  it('uses Quidax\'s record (amount and status), not the message\'s', async () => {
    const real = { id: 'dep-1', currency: 'usdt', amount: '5', status: 'accepted', user: { id: 'sub-1' } };
    const { c, quidax } = setup({ deposit: real });
    await expect(c.deposit(message as never)).resolves.toEqual(real);
    expect(quidax.fetchDeposit).toHaveBeenCalledWith('sub-1', 'dep-1');
  });

  it('a deposit Quidax has no record of is dropped (a possible forgery), not retried', async () => {
    const { c } = setup({ deposit: notFound() });
    await expect(c.deposit(message as never)).resolves.toBeNull();
  });

  it('a record for a different deposit or coin is dropped', async () => {
    expect(await setup({ deposit: { ...message, id: 'other' } }).c.deposit(message as never)).toBeNull();
    expect(await setup({ deposit: { ...message, currency: 'btc' } }).c.deposit(message as never)).toBeNull();
  });

  it('Quidax unreachable: throws, so the message is retried later (nothing credited on the message alone)', async () => {
    const { c } = setup({ deposit: new Error('connect ETIMEDOUT') });
    await expect(c.deposit(message as never)).rejects.toThrow('ETIMEDOUT');
  });

  it('a deposit for someone who is not our customer is dropped', async () => {
    const s = setup({ deposit: message });
    (s.c as unknown as { provisioning: { findUserByQuidax: jest.Mock } }).provisioning.findUserByQuidax.mockResolvedValueOnce(null);
    await expect(s.c.deposit(message as never)).resolves.toBeNull();
  });
});

describe('Withdrawals: finished or refunded only on what Quidax says', () => {
  const msg = { id: 'w1', reference: 'dvc_wd_1', status: 'rejected' };

  it('a "rejected" message while Quidax says DONE finishes it as sent: no refund of money that left', async () => {
    const real = { id: 'w1', reference: 'dvc_wd_1', status: 'Done' };
    const { c, quidax } = setup({ withdrawal: real });
    await expect(c.withdrawal(msg as never)).resolves.toEqual({ event: 'withdraw.successful', data: real });
    expect(quidax.fetchWithdrawalByReference).toHaveBeenCalledWith('dvc_wd_1', 'sub-1');
  });

  it('Quidax says rejected or failed: refund', async () => {
    for (const status of ['Rejected', 'failed']) {
      const { c } = setup({ withdrawal: { id: 'w1', reference: 'dvc_wd_1', status } });
      await expect(c.withdrawal(msg as never)).resolves.toMatchObject({ event: 'withdraw.rejected' });
    }
  });

  it('Quidax still processing, or no record: nothing now (reconciliation asks again)', async () => {
    expect(await setup({ withdrawal: { id: 'w1', reference: 'dvc_wd_1', status: 'Processing' } }).c.withdrawal(msg as never)).toBeNull();
    expect(await setup({ withdrawal: null }).c.withdrawal(msg as never)).toBeNull();
  });

  it('a reference that is not one of our customer withdrawals is left alone', async () => {
    expect(await setup({ tx: null }).c.withdrawal(msg as never)).toBeNull();
    expect(await setup({ tx: { type: 'BUY', userId: 'u1' } }).c.withdrawal(msg as never)).toBeNull();
  });

  it('Quidax unreachable: throws, retried later', async () => {
    await expect(setup({ withdrawal: new Error('socket hang up') }).c.withdrawal(msg as never)).rejects.toThrow('socket hang up');
  });
});

describe('Swaps: finished or reversed only on what Quidax says', () => {
  const msg = { id: 's1', status: 'completed' };

  it('a "complete" message while Quidax says failed reverses it', async () => {
    const real = { id: 's1', status: 'failed' };
    const { c, quidax } = setup({ swaps: [{ id: 'other', status: 'completed' }, real] });
    await expect(c.swap(msg as never)).resolves.toEqual({ event: 'swap_transaction.failed', data: real });
    expect(quidax.fetchSwapTransactions).toHaveBeenCalledWith('sub-1');
  });

  it('Quidax says completed: complete', async () => {
    const { c } = setup({ swaps: [{ id: 's1', status: 'Completed' }] });
    await expect(c.swap(msg as never)).resolves.toMatchObject({ event: 'swap_transaction.complete' });
  });

  it('a desk swap (our own account) is looked up in the main account', async () => {
    const { c, quidax } = setup({ swaps: [{ id: 's1', status: 'completed' }], leg: { transaction: { type: 'BUY', userId: 'u1' } } });
    await c.swap(msg as never);
    expect(quidax.fetchSwapTransactions).toHaveBeenCalledWith('me');
  });

  it('unknown swap, not ours, or still running: nothing', async () => {
    expect(await setup({ swaps: [] }).c.swap(msg as never)).toBeNull();
    expect(await setup({ leg: null }).c.swap(msg as never)).toBeNull();
    expect(await setup({ swaps: [{ id: 's1', status: 'pending' }] }).c.swap(msg as never)).toBeNull();
  });
});
