import { ConflictException } from '@nestjs/common';
import { FakePrisma } from '../ngn-deposits/testing/fake-prisma';
import { AdminTransactionsService } from './transactions.service';

async function setup(tx: Record<string, unknown> = {}, collection: Record<string, unknown> | null = { outcome: 'HELD' }) {
  const db = new FakePrisma();
  await db.transaction.create({
    data: {
      id: 't1', userId: 'u1', type: 'DEPOSIT', status: 'ON_HOLD', toAsset: 'ngn', toAmount: '1500.50',
      reference: 'flw:payin:42', failureReason: 'Over your daily limit', provider: 'FLUTTERWAVE',
      providerFee: '21.01', providerSettledAmount: '1479.49', ...tx,
    },
  });
  if (collection) {
    await db.flutterwaveCollection.create({
      data: { flwTransactionId: '42', firstSource: 'WEBHOOK', transactionId: 't1', userId: 'u1', ...collection },
    });
  }
  const ledger = { post: jest.fn(async () => undefined), credit: jest.fn(async () => undefined) };
  const notifications = { notify: jest.fn(async () => undefined) };
  const svc = new AdminTransactionsService(db as never, ledger as never, notifications as never, {} as never);
  // one() decorates with joins the fake does not model; the row itself is asserted from the fake.
  jest.spyOn(svc, 'one').mockImplementation(async (id: string) => ({ id }) as never);
  return { db, ledger, notifications, svc };
}

describe('AdminTransactionsService and Flutterwave deposits', () => {
  it('releases a held Flutterwave deposit with the same three entries, and marks the payment credited', async () => {
    const { db, ledger, notifications, svc } = await setup();
    await svc.release('t1');
    expect(ledger.credit).not.toHaveBeenCalled();
    expect(ledger.post).toHaveBeenCalledTimes(1);
    const [, legs, transactionId] = ledger.post.mock.calls[0] as unknown as [unknown, Array<{ account: string; amount: string }>, string];
    expect(transactionId).toBe('t1');
    expect(legs.map((l) => [l.account, l.amount])).toEqual([
      ['USER', '1500.5'],
      ['EXTERNAL', '1479.49'],
      ['PROVIDER_FEE', '21.01'],
    ]);
    expect(db.rows('transaction')[0]).toMatchObject({ status: 'COMPLETED', failureReason: null });
    expect(db.rows('flutterwaveCollection')[0]).toMatchObject({ outcome: 'CREDITED', previousOutcome: 'HELD' });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', type: 'deposit.credited' }));
  });

  it('refuses to release while a refund to the sender is in progress', async () => {
    const { db, ledger, svc } = await setup({}, { outcome: 'REFUND_PENDING' });
    const err = await svc.release('t1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/refund/i);
    expect(ledger.post).not.toHaveBeenCalled();
    expect(db.rows('transaction')[0].status).toBe('ON_HOLD');
  });

  it.each([
    ['without a recorded fee', { providerFee: null }],
    ['whose stored figures do not balance', { providerFee: '30' }],
  ])('refuses to release a Flutterwave deposit %s', async (_name, tx) => {
    const { ledger, svc } = await setup(tx);
    await expect(svc.release('t1')).rejects.toBeInstanceOf(ConflictException);
    expect(ledger.post).not.toHaveBeenCalled();
  });

  it('refuses a plain reject: a Flutterwave deposit must be refunded to its sender', async () => {
    const { db, svc } = await setup();
    const err = await svc.reject('t1', 'Not allowed').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/reject and refund/i);
    expect(db.rows('transaction')[0].status).toBe('ON_HOLD');
  });

  it('still releases a Quidax deposit with the single credit it always used', async () => {
    const { ledger, svc } = await setup(
      { provider: 'QUIDAX', providerFee: null, providerSettledAmount: null, reference: 'quidax_deposit_1' },
      null,
    );
    await svc.release('t1');
    expect(ledger.post).not.toHaveBeenCalled();
    expect(ledger.credit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'u1', assetCode: 'ngn', counterparty: 'EXTERNAL', transactionId: 't1' }),
    );
  });
});
