import { ConflictException } from '@nestjs/common';
import { PayrepMock } from '../payrep/payrep.mock';
import { PayrepRail } from '../naira-rail/payrep-rail';
import { AdminTransactionsService } from '../admin/transactions.service';
import { DepositRefundService, refundReference } from './deposit-refund.service';
import { FakePrisma } from './testing/fake-prisma';

/**
 * Plan 2026-10-22 Task 6: an admin's "reject" of a held Payrep deposit sends
 * the money back to the account it came from. The owner's rule: an unclear
 * result stays pending and is checked, never assumed failed.
 */
const USER = '7f3c2a1b-9e8d-4c6f-a1b2-c3d4e5f60718';

async function setup(amount = '1500.00', o: { senderAccount?: string | null } = {}) {
  const db = new FakePrisma();
  await db.user.create({ data: { id: USER, email: 'ada@example.com', firstName: 'Ada', lastName: 'Obi' } });
  const payrep = new PayrepMock({ port: 1 });
  jest.spyOn(payrep as unknown as { deliver: () => Promise<number> }, 'deliver').mockResolvedValue(200);
  const { transactionId: providerId } = await payrep.simulateDeposit({ accountNumber: '2012345678', amount, senderAccount: o.senderAccount });
  await db.transaction.create({
    data: {
      id: 't1', userId: USER, type: 'DEPOSIT', status: 'ON_HOLD', toAsset: 'ngn', toAmount: amount, provider: 'PAYREP',
      reference: `payrep:payin:${providerId}`, providerRef: providerId, failureReason: 'Over your daily limit',
    },
  });
  const collection = await db.nairaCollection.create({
    data: { providerTransactionId: providerId, firstSource: 'WEBHOOK', transactionId: 't1', userId: USER, outcome: 'HELD', amount, providerCreatedAt: new Date() },
  });
  const alerts = { raise: jest.fn(async () => true) };
  const rail = new PayrepRail(payrep, { mainAccount: '7801234567' } as never, alerts as never);
  const notifications = { notify: jest.fn(async () => undefined) };
  const hooks = { on: jest.fn() };
  const svc = new DepositRefundService(db as never, rail, payrep, notifications as never, alerts as never, undefined, hooks as never);
  const transfer = jest.spyOn(payrep, 'transfer');
  const reference = refundReference(collection.id as string);
  const row = () => db.rows('nairaCollection')[0];
  const tx = () => db.rows('transaction')[0];
  return { db, payrep, rail, alerts, notifications, hooks, svc, transfer, reference, row, tx };
}

describe('DepositRefundService: return a held Payrep deposit to its sender', () => {
  it('the reference is dvc_rfd_ and the collection id without dashes, and rechecks are registered for it', async () => {
    const s = await setup();
    expect(s.reference).toMatch(/^dvc_rfd_[0-9a-f]{32}$/);
    s.svc.onModuleInit();
    expect(s.hooks.on).toHaveBeenCalledWith('dvc_rfd_', expect.any(Function));
  });

  it('happy path: sends the full amount to the sender, RETURNING; the recheck finishes it REFUNDED + FAILED and tells the customer', async () => {
    const s = await setup('1500.00');
    await expect(s.svc.start('t1', 'Name does not match', 'admin1')).resolves.toEqual({ status: 'RETURNING' });
    expect(s.transfer).toHaveBeenCalledTimes(1);
    expect(s.transfer.mock.calls[0][0]).toMatchObject({ reference: s.reference, beneficiaryAccountNumber: '0123456789', amount: '1500.00' });
    expect(s.row()).toMatchObject({ outcome: 'REFUND_PENDING', previousOutcome: 'HELD' });
    expect(s.tx()).toMatchObject({ status: 'ON_HOLD', failureReason: 'Being returned to the sender: Name does not match' });

    await s.svc.recheck(s.reference);
    expect(s.row()).toMatchObject({ outcome: 'REFUNDED', previousOutcome: 'REFUND_PENDING' });
    expect(s.tx()).toMatchObject({ status: 'FAILED', failureReason: 'Returned to the sender: Name does not match' });
    expect(s.notifications.notify).toHaveBeenCalledTimes(1);
    expect(s.notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, transactionId: 't1', body: 'We returned your naira deposit of ₦1,500.00 to the account it came from. Reason: Name does not match' }),
    );

    // A second webhook or cron pass changes nothing and tells nobody again.
    await s.svc.recheck(s.reference);
    expect(s.notifications.notify).toHaveBeenCalledTimes(1);
  });

  it('two start() calls at once send ONE transfer (Review Focus 3)', async () => {
    const s = await setup();
    const results = await Promise.allSettled([s.svc.start('t1', 'r', 'a1'), s.svc.start('t1', 'r', 'a2')]);
    expect(s.transfer).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ConflictException);
  });

  it('no sender account from Payrep: 409, nothing sent, still HELD (Review Focus 4)', async () => {
    const s = await setup('1500.00', { senderAccount: null });
    const err = await s.svc.start('t1', 'r', 'a1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toBe("Payrep did not give the sender's account for this deposit. Return it from the Payrep dashboard, then mark it.");
    expect(s.transfer).not.toHaveBeenCalled();
    expect(s.row().outcome).toBe('HELD');
    expect(s.tx()).toMatchObject({ status: 'ON_HOLD', failureReason: 'Over your daily limit' });
  });

  it('a deposit that is not held (or not Payrep) is refused with 409', async () => {
    const s = await setup();
    await s.db.nairaCollection.update({ where: { transactionId: 't1' }, data: { outcome: 'CREDITED' } });
    await expect(s.svc.start('t1', 'r', 'a1')).rejects.toThrow('That deposit was already dealt with');
    expect(s.transfer).not.toHaveBeenCalled();
  });

  it('Payrep refuses (nothing sent): back to HELD, the old reason restored, 409 with the reason', async () => {
    const s = await setup('1500.51');
    const err = await s.svc.start('t1', 'r', 'a1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/Insufficient balance/);
    expect(s.row()).toMatchObject({ outcome: 'HELD' });
    expect(s.tx()).toMatchObject({ status: 'ON_HOLD', failureReason: 'Over your daily limit' });
  });

  it('an unclear answer stays REFUND_PENDING and answers RETURNING (owner rule)', async () => {
    const s = await setup('1500.80');
    await expect(s.svc.start('t1', 'r', 'a1')).resolves.toEqual({ status: 'RETURNING' });
    expect(s.row().outcome).toBe('REFUND_PENDING');
    expect(s.tx().status).toBe('ON_HOLD');
  });

  it('a recheck that finds FAILED puts it back on HELD and raises an alert', async () => {
    const s = await setup('1500.13');
    await s.svc.start('t1', 'r', 'a1');
    await s.svc.recheck(s.reference);
    expect(s.row()).toMatchObject({ outcome: 'HELD', previousOutcome: 'REFUND_PENDING' });
    expect(s.tx().status).toBe('ON_HOLD');
    expect(s.alerts.raise).toHaveBeenCalledWith('NGN_RECONCILIATION', expect.stringContaining('refund-failed:'), expect.stringContaining('Returning deposit'), expect.any(Array), expect.anything());
    expect(s.notifications.notify).not.toHaveBeenCalled();
  });

  it('a recheck that finds nothing (NOT_FOUND) or an unclear status changes nothing', async () => {
    const lost = await setup('1500.80'); // never recorded by Payrep
    await lost.svc.start('t1', 'r', 'a1');
    await lost.svc.recheck(lost.reference);
    expect(lost.row().outcome).toBe('REFUND_PENDING');

    const unclear = await setup('1500.98'); // status check always unavailable
    await unclear.svc.start('t1', 'r', 'a1');
    await unclear.svc.recheck(unclear.reference);
    expect(unclear.row().outcome).toBe('REFUND_PENDING');
    expect(unclear.tx().status).toBe('ON_HOLD');
  });

  it('a recheck for a reference that is not ours, or not pending, does nothing', async () => {
    const s = await setup();
    const status = jest.spyOn(s.rail, 'transferStatus');
    await s.svc.recheck('trsy_123');
    await s.svc.recheck(s.reference); // still HELD: nothing was started
    expect(status).not.toHaveBeenCalled();
  });

  it('the cron rechecks every pending return', async () => {
    const s = await setup();
    await s.svc.start('t1', 'r', 'a1');
    await s.svc.recheckOpen();
    expect(s.row().outcome).toBe('REFUNDED');
  });
});

describe('AdminTransactionsService.reject and naira bank deposits', () => {
  async function admin(provider: string) {
    const db = new FakePrisma();
    await db.transaction.create({
      data: { id: 't1', userId: 'u1', type: 'DEPOSIT', status: 'ON_HOLD', toAsset: 'ngn', toAmount: '1500', reference: 'r1', provider },
    });
    const notifications = { notify: jest.fn(async () => undefined) };
    const refunds = { start: jest.fn(async () => ({ status: 'RETURNING' })) };
    const svc = new AdminTransactionsService(db as never, {} as never, notifications as never, {} as never, refunds as never);
    jest.spyOn(svc, 'one').mockImplementation(async (id: string) => ({ id }) as never);
    return { db, svc, refunds, notifications };
  }

  it('a PAYREP deposit is returned to its sender through the refund service', async () => {
    const a = await admin('PAYREP');
    await a.svc.reject('t1', 'Name does not match', 'admin1');
    expect(a.refunds.start).toHaveBeenCalledWith('t1', 'Name does not match', 'admin1');
    expect(a.notifications.notify).not.toHaveBeenCalled();
  });

  it('a QUIDAX deposit is plainly rejected as before', async () => {
    const a = await admin('QUIDAX');
    await a.svc.reject('t1', 'Not allowed', 'admin1');
    expect(a.refunds.start).not.toHaveBeenCalled();
    expect(a.db.rows('transaction')[0]).toMatchObject({ status: 'FAILED', failureReason: 'Not allowed' });
  });

  it('a FLUTTERWAVE deposit is still refused (no rail to send it back)', async () => {
    const a = await admin('FLUTTERWAVE');
    await expect(a.svc.reject('t1', 'x', 'admin1')).rejects.toBeInstanceOf(ConflictException);
    expect(a.refunds.start).not.toHaveBeenCalled();
  });
});
