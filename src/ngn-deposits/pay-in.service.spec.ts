import { Logger } from '@nestjs/common';
import { dec } from '../common/money';
import { FlutterwaveError, FlutterwaveUnknownError } from '../flutterwave/flutterwave.errors';
import { FlutterwaveMockClient } from '../flutterwave/flutterwave.mock';
import type { FlwTransaction, FlwTransactionMeta } from '../flutterwave/flutterwave.types';
import type { LedgerLeg } from '../ledger/ledger.service';
import { PayInProcessor } from './pay-in.processor';
import { PayInService, type PayInJob } from './pay-in.service';
import { FakePrisma, p2002 } from './testing/fake-prisma';
import { VirtualAccountsService } from './virtual-accounts.service';

const USER = '7f3c2a1b-9e8d-4c6f-a1b2-c3d4e5f60718';
const TX_REF = 'dcva_7f3c2a1b9e8d4c6fa1b2c3d4e5f60718';
const ACCOUNT = '9000000001';
let nextId = 5_000_000;

const net = (legs: LedgerLeg[]) =>
  legs.reduce((sum, l) => (l.direction === 'DEBIT' ? sum.plus(dec(l.amount)) : sum.minus(dec(l.amount))), dec(0));

interface Options {
  limit?: { allowed: boolean; reason?: string };
  user?: Record<string, unknown>;
}

async function setup(o: Options = {}) {
  const db = new FakePrisma();
  await db.user.create({
    data: {
      id: USER, email: 'ada@example.com', firstName: 'Ada', lastName: 'Obi',
      status: 'ACTIVE', kycTier: 'TIER_1', kycStatus: 'APPROVED', ...o.user,
    },
  });
  await db.virtualAccount.create({
    data: {
      userId: USER, orderRef: 'URF_1', accountNumber: ACCOUNT, accountName: 'Ada Obi', bankName: 'Flutterwave MFB',
      txRef: TX_REF, isPrimary: true, source: 'CREATED', providerStatus: 'active',
    },
  });
  const client = new FlutterwaveMockClient({
    rateLimitPerMinute: 100_000, port: 1, secretKey: async () => 'FLWSECK_TEST-x-X', secretHash: async () => 'h',
  } as never);
  const alerts = { raise: jest.fn(async () => true) };
  const accounts = new VirtualAccountsService(db as never, client, {} as never, {} as never, alerts as never);
  const posts: Array<{ legs: LedgerLeg[]; transactionId?: string }> = [];
  const ledger = {
    post: jest.fn(async (_t: unknown, legs: LedgerLeg[], transactionId?: string) => {
      posts.push({ legs, transactionId });
    }),
  };
  const kycLimits = { checkInTransaction: jest.fn(async () => o.limit ?? { allowed: true }) };
  const notifications = { notify: jest.fn(async () => undefined) };
  const rates = { price: jest.fn(async () => ({ ngnPerUsd: dec('1500') })) };
  const queue = { add: jest.fn(async () => undefined) };
  const svc = new PayInService(
    db as never, client, accounts, ledger as never, kycLimits as never,
    notifications as never, rates as never, alerts as never, queue as never,
  );

  /** A payment into Ada's account, exactly as Flutterwave's verify will describe it. */
  const pay = (over: Partial<FlwTransaction> = {}, meta: Partial<FlwTransactionMeta> = {}): string => {
    const id = over.id ?? String(nextId++);
    client.seedTransaction({
      id, tx_ref: TX_REF, flw_ref: `SESSION${id}`, amount: '1500', charged_amount: '1500', app_fee: '21',
      merchant_fee: '0', amount_settled: '1479', currency: 'NGN', status: 'successful', payment_type: 'bank_transfer',
      created_at: '2026-10-07T14:14:32.000Z', ...over,
      meta: {
        virtualaccountnumber: ACCOUNT, originatorname: 'ADA OBI', bankname: 'Access Bank', bankcode: '044',
        originatoraccountnumber: '123*******90', ...meta,
      },
    });
    return id;
  };
  return { db, client, alerts, posts, kycLimits, notifications, queue, svc, pay };
}

describe('PayInService.processPayment', () => {
  it('credits a verified deposit with three balanced entries, once, and tells the user', async () => {
    const { svc, db, posts, notifications, pay } = await setup();
    const id = pay();
    await expect(svc.processPayment(id, 'WEBHOOK')).resolves.toEqual({ outcome: 'CREDITED', changed: true });

    const [tx] = db.rows('transaction');
    expect(tx).toMatchObject({
      userId: USER, type: 'DEPOSIT', status: 'COMPLETED', toAsset: 'ngn', reference: `flw:payin:${id}`,
      provider: 'FLUTTERWAVE', providerRef: id, counterpartyName: 'ADA OBI', counterpartyBank: 'Access Bank',
      counterpartyAccountMasked: '123*******90', nameMismatch: false, failureReason: null,
    });
    expect([String(tx.toAmount), String(tx.providerFee), String(tx.providerSettledAmount), String(tx.usdValue)]).toEqual(['1500', '21', '1479', '1']);

    expect(posts).toHaveLength(1);
    expect(posts[0].transactionId).toBe(tx.id);
    const memo = `flutterwave deposit ${id}`;
    expect(posts[0].legs).toEqual([
      { account: 'USER', userId: USER, assetCode: 'ngn', direction: 'CREDIT', amount: '1500', memo },
      { account: 'EXTERNAL', assetCode: 'ngn', direction: 'DEBIT', amount: '1479', memo },
      { account: 'PROVIDER_FEE', assetCode: 'ngn', direction: 'DEBIT', amount: '21', memo },
    ]);
    expect(net(posts[0].legs).isZero()).toBe(true);

    expect(db.rows('flutterwaveCollection')[0]).toMatchObject({
      flwTransactionId: id, outcome: 'CREDITED', previousOutcome: 'UNVERIFIED', userId: USER, transactionId: tx.id,
      providerStatus: 'successful', paymentType: 'bank_transfer', payerName: 'ADA OBI', checkCount: 1, firstSource: 'WEBHOOK',
    });
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER, transactionId: tx.id, type: 'deposit.credited',
        email: { key: 'ngn.deposit.credited', variables: { amount: '1500.00', transactionId: tx.id } },
      }),
    );
  });

  it('does nothing the second time: no second transaction, entry or notification', async () => {
    const { svc, db, posts, notifications, pay } = await setup();
    const id = pay();
    await svc.processPayment(id, 'WEBHOOK');
    await expect(svc.processPayment(id, 'SWEEP')).resolves.toEqual({ outcome: 'CREDITED', changed: false });
    expect(db.rows('transaction')).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(db.rows('flutterwaveCollection')[0].checkCount).toBe(2);
  });

  it('credits what verify says, never what the webhook said', async () => {
    const { svc, db, posts, pay } = await setup();
    const id = pay();
    await db.flutterwaveCollection.create({
      data: { flwTransactionId: id, firstSource: 'WEBHOOK', webhookHint: { amount: '999999', txRef: 'dcva_00000000000000000000000000000000' } },
    });
    await svc.processPayment(id, 'WEBHOOK');
    expect(posts[0].legs[0]).toMatchObject({ userId: USER, amount: '1500' });
  });

  it('keeps kobo exact', async () => {
    const { svc, posts, pay } = await setup();
    const id = pay({ amount: '1500.50', charged_amount: '1500.50', app_fee: '21.01', amount_settled: '1479.49' });
    await svc.processPayment(id);
    expect(posts[0].legs.map((l) => l.amount)).toEqual(['1500.5', '1479.49', '21.01']);
    expect(net(posts[0].legs).isZero()).toBe(true);
  });

  it('posts two entries when Flutterwave kept no fee', async () => {
    const { svc, posts, pay } = await setup();
    await svc.processPayment(pay({ app_fee: '0', amount_settled: '1500' }));
    expect(posts[0].legs.map((l) => l.account)).toEqual(['USER', 'EXTERNAL']);
  });

  it('posts nothing and disputes the payment when amount ≠ settled + fee', async () => {
    const { svc, db, posts, alerts, notifications, pay } = await setup();
    const id = pay({ app_fee: '25' });
    await expect(svc.processPayment(id)).resolves.toEqual({ outcome: 'DISPUTED', changed: true });
    expect(posts).toHaveLength(0);
    expect(db.rows('transaction')).toHaveLength(0);
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(alerts.raise).toHaveBeenCalledWith('NGN_RECONCILIATION', `disputed:${id}`, expect.any(String), expect.any(Array), expect.any(Number));
  });

  it.each([
    ['pending', 'PENDING_PROVIDER'],
    ['abandoned', 'PENDING_PROVIDER'],
    ['failed', 'PROVIDER_FAILED'],
  ])('does not credit a payment Flutterwave calls "%s" (→ %s)', async (status, outcome) => {
    const { svc, posts, pay } = await setup();
    await expect(svc.processPayment(pay({ status }))).resolves.toEqual({ outcome, changed: true });
    expect(posts).toHaveLength(0);
  });

  it('disputes a credited deposit that Flutterwave later calls failed, and claws nothing back', async () => {
    const { svc, db, client, posts, alerts, pay } = await setup();
    const id = pay();
    await svc.processPayment(id);
    client.seedTransaction({ ...(await client.verifyTransaction(id)), status: 'failed' });
    await expect(svc.processPayment(id)).resolves.toEqual({ outcome: 'DISPUTED', changed: true });
    expect(posts).toHaveLength(1);
    expect(db.rows('transaction')[0].status).toBe('COMPLETED');
    expect(alerts.raise).toHaveBeenCalledWith('NGN_RECONCILIATION', `disputed:${id}`, expect.stringMatching(/failed/), expect.any(Array), expect.any(Number));
  });

  it('disputes a credited deposit whose verified amount changes', async () => {
    const { svc, client, posts, pay } = await setup();
    const id = pay();
    await svc.processPayment(id);
    client.seedTransaction({ ...(await client.verifyTransaction(id)), amount: '15000', charged_amount: '15000', amount_settled: '14979' });
    await expect(svc.processPayment(id)).resolves.toEqual({ outcome: 'DISPUTED', changed: true });
    expect(posts).toHaveLength(1);
  });

  it('lists a payment that is not a bank transfer as NON_CUSTOMER, without an alert', async () => {
    const { svc, alerts, posts, pay } = await setup();
    await expect(svc.processPayment(pay({ payment_type: 'card' }))).resolves.toEqual({ outcome: 'NON_CUSTOMER', changed: true });
    expect(posts).toHaveLength(0);
    expect(alerts.raise).not.toHaveBeenCalled();
  });

  it('holds back and alerts on a currency other than naira', async () => {
    const { svc, alerts, posts, pay } = await setup();
    const id = pay({ currency: 'USD' });
    await expect(svc.processPayment(id)).resolves.toEqual({ outcome: 'UNMATCHED', changed: true });
    expect(posts).toHaveLength(0);
    expect(alerts.raise).toHaveBeenCalledWith('NGN_DEPOSIT_UNMATCHED', `currency:${id}`, expect.any(String), expect.any(Array), expect.any(Number));
  });

  it('records NOT_FOUND when Flutterwave has no such payment (a forged webhook)', async () => {
    const { svc, db, posts } = await setup();
    await expect(svc.processPayment('424242', 'WEBHOOK')).resolves.toEqual({ outcome: 'NOT_FOUND', changed: true });
    expect(db.rows('flutterwaveCollection')[0]).toMatchObject({ flwTransactionId: '424242', outcome: 'NOT_FOUND' });
    expect(posts).toHaveLength(0);
  });

  it('throws on an unknown verify answer so the job retries, leaving the payment untouched', async () => {
    const { svc, db, client, pay } = await setup();
    const id = pay();
    await db.flutterwaveCollection.create({ data: { flwTransactionId: id, firstSource: 'WEBHOOK' } });
    client.failNext('verifyTransaction', new FlutterwaveUnknownError('timeout', 'GET', `/transactions/${id}/verify`));
    await expect(svc.processPayment(id)).rejects.toBeInstanceOf(FlutterwaveUnknownError);
    expect(db.rows('flutterwaveCollection')[0]).toMatchObject({ outcome: 'UNVERIFIED', checkCount: 0 });
  });

  it('throws and alerts when Flutterwave refuses our key', async () => {
    const { svc, client, alerts, pay } = await setup();
    const id = pay();
    client.failNext('verifyTransaction', new FlutterwaveError('CONFIG', 'Authorization required', 401));
    await expect(svc.processPayment(id)).rejects.toBeInstanceOf(FlutterwaveError);
    expect(alerts.raise).toHaveBeenCalledWith('FLUTTERWAVE_CONFIG', 'config', expect.any(String), expect.any(Array));
  });

  it('refuses an answer about a different payment', async () => {
    const { svc, client, posts, pay } = await setup();
    const id = pay();
    const other = await client.verifyTransaction(id);
    jest.spyOn(client, 'verifyTransaction').mockResolvedValueOnce({ ...other, id: '1' });
    await expect(svc.processPayment(id)).rejects.toThrow(/asked about/);
    expect(posts).toHaveLength(0);
  });

  it("finds the owner by the paid account when the tx_ref isn't ours", async () => {
    const { svc, posts, pay } = await setup();
    await expect(svc.processPayment(pay({ tx_ref: 'dcbt_foreign_ref' }))).resolves.toMatchObject({ outcome: 'CREDITED' });
    expect(posts[0].legs[0].userId).toBe(USER);
  });

  it('records an account it never knew about, and credits the owner its tx_ref names', async () => {
    const { svc, db, posts, pay } = await setup();
    await svc.processPayment(pay({}, { virtualaccountnumber: '0067100155' }));
    expect(posts[0].legs[0].userId).toBe(USER);
    expect(db.rows('virtualAccount').find((r) => r.accountNumber === '0067100155')).toMatchObject({
      source: 'DISCOVERED', isPrimary: false, orderRef: null, userId: USER,
    });
  });

  it('leaves an unattributable payment UNMATCHED and alerts', async () => {
    const { svc, posts, alerts, pay } = await setup();
    const id = pay({ tx_ref: 'dcbt_foreign_ref' }, { virtualaccountnumber: '1111111111' });
    await expect(svc.processPayment(id)).resolves.toEqual({ outcome: 'UNMATCHED', changed: true });
    expect(posts).toHaveLength(0);
    expect(alerts.raise).toHaveBeenCalledWith('NGN_DEPOSIT_UNMATCHED', `unmatched:${id}`, expect.any(String), expect.any(Array), expect.any(Number));
  });

  it('holds a deposit over the KYC limit: ON_HOLD, nothing posted, the user told', async () => {
    const { svc, db, posts, notifications, pay } = await setup({ limit: { allowed: false, reason: 'Over your daily limit' } });
    const id = pay();
    await expect(svc.processPayment(id)).resolves.toEqual({ outcome: 'HELD', changed: true });
    expect(db.rows('transaction')[0]).toMatchObject({ status: 'ON_HOLD', failureReason: 'Over your daily limit', completedAt: null });
    expect(posts).toHaveLength(0);
    expect(db.rows('flutterwaveCollection')[0]).toMatchObject({ outcome: 'HELD', transactionId: db.rows('transaction')[0].id });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'deposit.on_hold' }));
  });

  it('does nothing when a concurrent run won the unique reference', async () => {
    const { svc, db, posts, notifications, pay } = await setup();
    const id = pay();
    db.failNext('transaction', 'create', p2002(['reference']));
    // The winner's commit lands after our attempt rolls back.
    const real = db.serializable.bind(db);
    jest.spyOn(db, 'serializable').mockImplementationOnce((async (fn: never) => {
      try {
        return await real(fn);
      } catch (err) {
        await db.flutterwaveCollection.updateMany({ where: { flwTransactionId: id }, data: { outcome: 'CREDITED' } });
        throw err;
      }
    }) as never);
    await expect(svc.processPayment(id)).resolves.toEqual({ outcome: 'CREDITED', changed: false });
    expect(db.rows('flutterwaveCollection')[0].outcome).toBe('CREDITED');
    expect(posts).toHaveLength(0);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('retries (throws) when a conflict leaves the payment unsettled', async () => {
    const { svc, db, posts, notifications, pay } = await setup();
    const id = pay();
    db.failNext('transaction', 'create', p2002(['reference']));
    await expect(svc.processPayment(id)).rejects.toThrow(/not settled/);
    expect(posts).toHaveLength(0);
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(db.rows('flutterwaveCollection')[0].outcome).not.toBe('CREDITED');
  });

  it("credits, but flags, a deposit from someone whose name isn't the user's", async () => {
    const { svc, db, pay } = await setup();
    await expect(svc.processPayment(pay({}, { originatorname: 'JOHN DOE' }))).resolves.toMatchObject({ outcome: 'CREDITED' });
    expect(db.rows('transaction')[0]).toMatchObject({ nameMismatch: true, counterpartyName: 'JOHN DOE' });
  });

  it('credits a closed account as received, with a warning', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { svc, pay } = await setup({ user: { status: 'CLOSED' } });
      await expect(svc.processPayment(pay())).resolves.toMatchObject({ outcome: 'CREDITED' });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/closed account/));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('PayInService.enqueue and the worker', () => {
  it('queues webhook jobs under one id per payment, and sweep or re-check jobs under fresh ones', async () => {
    const { svc, queue } = await setup();
    await svc.enqueue('10535993', 'WEBHOOK');
    await svc.enqueue('10535993', 'SWEEP');
    await svc.enqueue('10535993', 'RECHECK');
    const calls = queue.add.mock.calls as unknown as Array<[string, PayInJob, { jobId: string }]>;
    expect(calls[0]).toEqual([
      'process-flw-payin',
      { flwTransactionId: '10535993', reason: 'WEBHOOK' },
      expect.objectContaining({ jobId: 'flwin-10535993', attempts: 8, backoff: { type: 'exponential', delay: 30_000 } }),
    ]);
    expect(calls[1][2].jobId).toMatch(/^flwin-10535993-sweep-\d+$/);
    expect(calls[2][2].jobId).toMatch(/^flwin-10535993-recheck-\d+$/);
  });

  it('runs only its own job, and passes the source on', async () => {
    const payIn = { processPayment: jest.fn(async () => ({ outcome: 'CREDITED', changed: true })) };
    const worker = new PayInProcessor(payIn as never);
    await expect(worker.process({ name: 'something-else', data: {} } as never)).resolves.toBeNull();
    await worker.process({ name: 'process-flw-payin', data: { flwTransactionId: '1', reason: 'WEBHOOK' }, attemptsMade: 0 } as never);
    await worker.process({ name: 'process-flw-payin', data: { flwTransactionId: '2', reason: 'RECHECK' }, attemptsMade: 0 } as never);
    expect(payIn.processPayment.mock.calls).toEqual([
      ['1', 'WEBHOOK'],
      ['2', 'SWEEP'],
    ]);
  });
});
