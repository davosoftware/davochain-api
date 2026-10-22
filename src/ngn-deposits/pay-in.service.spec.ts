import { Logger } from '@nestjs/common';
import { dec } from '../common/money';
import type { LedgerLeg } from '../ledger/ledger.service';
import { PayrepError } from '../payrep/payrep.errors';
import { PayrepMock } from '../payrep/payrep.mock';
import type { PayrepCollection } from '../payrep/payrep.types';
import { PayInProcessor } from './pay-in.processor';
import { PayInService, type PayInJob } from './pay-in.service';
import { FakePrisma, p2002 } from './testing/fake-prisma';
import { VirtualAccountsService } from './virtual-accounts.service';

const USER = '7f3c2a1b-9e8d-4c6f-a1b2-c3d4e5f60718';
const ACC = '2012345678';
const HOUR = 3_600_000;

const net = (legs: LedgerLeg[]) =>
  legs.reduce((sum, l) => (l.direction === 'DEBIT' ? sum.plus(dec(l.amount)) : sum.minus(dec(l.amount))), dec(0));

interface Options {
  limit?: { allowed: boolean; reason?: string };
  user?: Record<string, unknown>;
}

async function setup(o: Options = {}) {
  const db = new FakePrisma();
  await db.user.create({
    data: { id: USER, email: 'ada@example.com', firstName: 'Ada', lastName: 'Obi', status: 'ACTIVE', kycTier: 'TIER_1', kycStatus: 'APPROVED', ...o.user },
  });
  await db.virtualAccount.create({
    data: { userId: USER, accountNumber: ACC, accountName: 'Ada Obi', bankName: 'Payrep MFB', isPrimary: true, source: 'CREATED', providerStatus: 'active' },
  });
  const payrep = new PayrepMock({ port: 1 });
  jest.spyOn(payrep as unknown as { deliver: () => Promise<number> }, 'deliver').mockResolvedValue(200);
  const alerts = { raise: jest.fn(async () => true) };
  const accounts = new VirtualAccountsService(db as never, payrep, { mainAccount: '7801234567' } as never, {} as never, {} as never, alerts as never);
  const posts: Array<{ legs: LedgerLeg[]; transactionId?: string }> = [];
  const ledger = {
    post: jest.fn(async (_t: unknown, legs: LedgerLeg[], transactionId?: string) => {
      posts.push({ legs, transactionId });
    }),
  };
  const kycLimits = { fx: jest.fn(async () => ({ ngnPerUsd: '1500' })), checkInTransaction: jest.fn(async () => o.limit ?? { allowed: true }) };
  const notifications = { notify: jest.fn(async () => undefined) };
  const rates = { price: jest.fn(async () => ({ ngnPerUsd: dec('1500') })) };
  const queue = { add: jest.fn(async () => undefined) };
  const svc = new PayInService(db as never, payrep, accounts, ledger as never, kycLimits as never, notifications as never, rates as never, alerts as never, queue as never);

  /** A customer pays into an account, and the webhook hint arrives. */
  const deposit = async (amount = '1500.00', over: { fee?: string; status?: 'success' | 'pending' | 'failed'; senderName?: string; account?: string } = {}) => {
    const accountNumber = over.account ?? ACC;
    const { transactionId } = await payrep.simulateDeposit({ accountNumber, amount, fee: over.fee ?? '21.00', status: over.status, senderName: over.senderName ?? 'ADA OBI' });
    await svc.intake({ transactionId, accountNumber, referenceNumber: null, createdAt: new Date().toISOString(), event: 'deposit.success' }, 'WEBHOOK');
    return transactionId;
  };
  return { db, payrep, accounts, alerts, posts, kycLimits, notifications, queue, svc, deposit };
}

describe('PayInService.processPayment (Payrep, spec §6)', () => {
  it('confirms with Payrep, credits once with three balanced entries, and tells the user', async () => {
    const { svc, db, posts, notifications, deposit } = await setup();
    const id = await deposit('1500.00', { fee: '21.00' });
    await expect(svc.processPayment(id)).resolves.toEqual({ outcome: 'CREDITED', changed: true });

    const [tx] = db.rows('transaction');
    expect(tx).toMatchObject({
      userId: USER, type: 'DEPOSIT', status: 'COMPLETED', toAsset: 'ngn', reference: `payrep:payin:${id}`, provider: 'PAYREP', providerRef: id,
      counterpartyName: 'ADA OBI', counterpartyBank: 'Access Bank', counterpartyAccountMasked: '******6789', nameMismatch: false, failureReason: null,
    });
    expect([String(tx.toAmount), String(tx.providerFee), String(tx.providerSettledAmount), String(tx.usdValue)]).toEqual(['1500', '21', '1479', '1']);

    const memo = `payrep deposit ${id}`;
    expect(posts).toEqual([
      {
        transactionId: tx.id,
        legs: [
          { account: 'USER', userId: USER, assetCode: 'ngn', direction: 'CREDIT', amount: '1500', memo },
          { account: 'EXTERNAL', assetCode: 'ngn', direction: 'DEBIT', amount: '1479', memo },
          { account: 'PROVIDER_FEE', assetCode: 'ngn', direction: 'DEBIT', amount: '21', memo },
        ],
      },
    ]);
    expect(net(posts[0].legs).isZero()).toBe(true);
    expect(db.rows('nairaCollection')[0]).toMatchObject({
      providerTransactionId: id, outcome: 'CREDITED', previousOutcome: 'UNVERIFIED', userId: USER, transactionId: tx.id,
      providerStatus: 'successful', accountNumber: ACC, payerName: 'ADA OBI', checkCount: 1, firstSource: 'WEBHOOK',
    });
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, transactionId: tx.id, type: 'deposit.credited', email: { key: 'ngn.deposit.credited', variables: { amount: '1500.00', transactionId: tx.id } } }),
    );
  });

  it('does nothing the second time: no second transaction, entry or notification', async () => {
    const { svc, db, posts, notifications, deposit } = await setup();
    const id = await deposit();
    await svc.processPayment(id);
    await expect(svc.processPayment(id)).resolves.toEqual({ outcome: 'CREDITED', changed: false });
    expect(db.rows('transaction')).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(db.rows('nairaCollection')[0].checkCount).toBe(2);
  });

  it('keeps kobo exact, and posts two entries when Payrep kept no fee', async () => {
    const { svc, posts, deposit } = await setup();
    await svc.processPayment(await deposit('1500.50', { fee: '21.01' }));
    expect(posts[0].legs.map((l) => l.amount)).toEqual(['1500.5', '1479.49', '21.01']);
    await svc.processPayment(await deposit('300.00', { fee: '0.00' }));
    expect(posts[1].legs.map((l) => l.account)).toEqual(['USER', 'EXTERNAL']);
  });

  it('a webhook Payrep cannot confirm is NOT credited (Review Focus 2)', async () => {
    const { svc, db, posts } = await setup();
    await svc.intake({ transactionId: 'forged', accountNumber: ACC, referenceNumber: null, createdAt: new Date().toISOString(), event: 'deposit.success' }, 'WEBHOOK');
    await expect(svc.processPayment('forged')).rejects.toThrow(/not yet visible/);
    expect(db.rows('nairaCollection')[0]).toMatchObject({ providerTransactionId: 'forged', outcome: 'UNVERIFIED', checkCount: 1 });
    expect(posts).toHaveLength(0);
  });

  it('a hint naming the wrong account cannot redirect money: only Payrep’s own record decides', async () => {
    const { svc, db, posts, payrep } = await setup();
    const { transactionId } = await payrep.simulateDeposit({ accountNumber: ACC, amount: '500.00' });
    await svc.intake({ transactionId, accountNumber: '2099999999', referenceNumber: null, createdAt: null, event: 'deposit.success' }, 'WEBHOOK');
    // Found by its exact id; the account (so the owner) is the one in Payrep's record, not the hint's.
    await expect(svc.processPayment(transactionId)).resolves.toMatchObject({ outcome: 'CREDITED' });
    expect(posts[0].legs[0]).toMatchObject({ userId: USER, amount: '500' });
    expect(db.rows('nairaCollection')[0].accountNumber).toBe(ACC);
  });

  it("finds the payment even when Payrep's account filter misses it (seen on the sandbox, 22 Oct 2026)", async () => {
    const { svc, payrep, posts, deposit } = await setup();
    const id = await deposit('250.00');
    const real = payrep.fetchCredits.bind(payrep);
    const calls: Array<{ accountNumber?: string }> = [];
    jest.spyOn(payrep, 'fetchCredits').mockImplementation(async (f) => {
      calls.push(f);
      return f.accountNumber ? { items: [], next: null } : real(f);
    });
    await expect(svc.processPayment(id)).resolves.toMatchObject({ outcome: 'CREDITED' });
    expect(calls.map((f) => Boolean(f.accountNumber))).toEqual([true, false]);
    expect(posts[0].legs[0]).toMatchObject({ amount: '250' });
  });

  it('after 48 hours unconfirmed: NOT_FOUND, with an alert', async () => {
    const { svc, db, alerts } = await setup();
    await svc.intake({ transactionId: 'ghost', accountNumber: ACC, referenceNumber: null, createdAt: null, event: 'deposit.success' }, 'WEBHOOK');
    await db.nairaCollection.update({ where: { providerTransactionId: 'ghost' }, data: { firstSeenAt: new Date(Date.now() - 49 * HOUR) } });
    await expect(svc.processPayment('ghost')).resolves.toEqual({ outcome: 'NOT_FOUND', changed: true });
    expect(alerts.raise).toHaveBeenCalledWith('NGN_DEPOSIT_UNMATCHED', 'notfound:ghost', expect.any(String), expect.any(Array), expect.any(Number));
    // A later look that still finds nothing changes nothing, alerts nobody again, and does not throw.
    alerts.raise.mockClear();
    await expect(svc.processPayment('ghost')).resolves.toEqual({ outcome: 'NOT_FOUND', changed: false });
    expect(alerts.raise).not.toHaveBeenCalled();
  });

  it('NOT_FOUND is not final: if Payrep later shows the payment, it is credited (final review I3)', async () => {
    const { svc, db, payrep, posts } = await setup();
    const { transactionId } = await payrep.simulateDeposit({ accountNumber: ACC, amount: '800.00' });
    await svc.intake({ transactionId, accountNumber: ACC, referenceNumber: null, createdAt: null, event: 'deposit.success' }, 'WEBHOOK');
    await db.nairaCollection.update({ where: { providerTransactionId: transactionId }, data: { outcome: 'NOT_FOUND', firstSeenAt: new Date(Date.now() - 49 * HOUR) } });
    await expect(svc.processPayment(transactionId)).resolves.toEqual({ outcome: 'CREDITED', changed: true });
    expect(posts).toHaveLength(1);
  });

  it('an unclear Payrep answer throws so the job retries, leaving the payment untouched', async () => {
    const { svc, db, payrep, deposit } = await setup();
    const id = await deposit();
    jest.spyOn(payrep, 'fetchCredits').mockRejectedValueOnce(new PayrepError('UNCLEAR', 'timeout', 0, null));
    await expect(svc.processPayment(id)).rejects.toBeInstanceOf(PayrepError);
    expect(db.rows('nairaCollection')[0]).toMatchObject({ outcome: 'UNVERIFIED' });
  });

  it('a CONFIG refusal throws and alerts', async () => {
    const { svc, payrep, alerts, deposit } = await setup();
    const id = await deposit();
    jest.spyOn(payrep, 'fetchCredits').mockRejectedValueOnce(new PayrepError('CONFIG', 'Unauthorized', 200, '41'));
    await expect(svc.processPayment(id)).rejects.toBeInstanceOf(PayrepError);
    expect(alerts.raise).toHaveBeenCalledWith('NAIRA_RAIL_CONFIG', 'config', expect.any(String), expect.any(Array));
  });

  it.each([
    ['pending', 'PENDING_PROVIDER'],
    ['failed', 'PROVIDER_FAILED'],
  ])('a deposit Payrep calls "%s" is never credited (→ %s)', async (status, outcome) => {
    const { svc, posts, deposit } = await setup();
    await expect(svc.processPayment(await deposit('10.00', { status: status as 'pending' | 'failed' }))).resolves.toEqual({ outcome, changed: true });
    expect(posts).toHaveLength(0);
  });

  /** Payrep's record of the payment, with some fields changed. */
  const reshape = (payrep: PayrepMock, over: Partial<PayrepCollection>) => {
    const real = payrep.fetchCredits.bind(payrep);
    jest.spyOn(payrep, 'fetchCredits').mockImplementation(async (f) => {
      const r = await real(f);
      return { ...r, items: r.items.map((c: PayrepCollection) => ({ ...c, ...over })) };
    });
  };

  it('an unknown status is treated as pending AND owners are told (final review I1)', async () => {
    const { svc, payrep, posts, alerts, deposit } = await setup();
    const id = await deposit();
    reshape(payrep, { status: 'completed' });
    await expect(svc.processPayment(id)).resolves.toEqual({ outcome: 'PENDING_PROVIDER', changed: true });
    expect(posts).toHaveLength(0);
    expect(alerts.raise).toHaveBeenCalledWith('NGN_RECONCILIATION', `unknown-status:${id}`, expect.stringMatching(/completed/), expect.any(Array), expect.any(Number));
  });

  it.each(['debit', 'dr', 'DR'])('a "%s" is not a customer deposit: NON_CUSTOMER, no alert', async (transactionType) => {
    const { svc, payrep, alerts, posts, deposit } = await setup();
    const id = await deposit();
    reshape(payrep, { transactionType: transactionType.toLowerCase() });
    await expect(svc.processPayment(id)).resolves.toEqual({ outcome: 'NON_CUSTOMER', changed: true });
    expect(posts).toHaveLength(0);
    expect(alerts.raise).not.toHaveBeenCalled();
  });

  it.each(['cr', null])('a credit written "%s" is credited', async (transactionType) => {
    const { svc, payrep, deposit } = await setup();
    const id = await deposit();
    reshape(payrep, { transactionType });
    await expect(svc.processPayment(id)).resolves.toMatchObject({ outcome: 'CREDITED' });
  });

  it('an unknown transaction type is never parked: it stays UNVERIFIED for the re-check, and owners are told (final review I1)', async () => {
    const { svc, db, payrep, posts, alerts, deposit } = await setup();
    const id = await deposit();
    reshape(payrep, { transactionType: 'inflow' });
    await expect(svc.processPayment(id)).resolves.toEqual({ outcome: 'UNVERIFIED', changed: false });
    expect(db.rows('nairaCollection')[0].outcome).toBe('UNVERIFIED');
    expect(posts).toHaveLength(0);
    expect(alerts.raise).toHaveBeenCalledWith('NGN_RECONCILIATION', `unknown-type:${id}`, expect.stringMatching(/inflow/), expect.any(Array), expect.any(Number));
  });

  it('a deposit into an account that is switched off is HELD, not credited (Review Focus 4)', async () => {
    const { svc, db, accounts, posts, notifications, deposit } = await setup();
    await accounts.setDesiredForUser(USER, 'INACTIVE');
    await expect(svc.processPayment(await deposit('300.00'))).resolves.toEqual({ outcome: 'HELD', changed: true });
    expect(posts).toHaveLength(0);
    expect(db.rows('transaction')[0]).toMatchObject({ status: 'ON_HOLD', failureReason: expect.stringMatching(/switched off/), completedAt: null });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'deposit.on_hold' }));
  });

  it('holds a deposit over the KYC limit: ON_HOLD, nothing posted, the user told', async () => {
    const { svc, db, posts, notifications, deposit } = await setup({ limit: { allowed: false, reason: 'Over your daily limit' } });
    await expect(svc.processPayment(await deposit('900000.00'))).resolves.toEqual({ outcome: 'HELD', changed: true });
    expect(db.rows('transaction')[0]).toMatchObject({ status: 'ON_HOLD', failureReason: 'Over your daily limit', completedAt: null });
    expect(posts).toHaveLength(0);
    expect(db.rows('nairaCollection')[0]).toMatchObject({ outcome: 'HELD', transactionId: db.rows('transaction')[0].id });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'deposit.on_hold' }));
  });

  it('an account we do not know is UNMATCHED with an alert', async () => {
    const { svc, posts, alerts, deposit } = await setup();
    const id = await deposit('50.00', { account: '2099999999' });
    await expect(svc.processPayment(id)).resolves.toEqual({ outcome: 'UNMATCHED', changed: true });
    expect(posts).toHaveLength(0);
    expect(alerts.raise).toHaveBeenCalledWith('NGN_DEPOSIT_UNMATCHED', `unmatched:${id}`, expect.any(String), expect.any(Array), expect.any(Number));
  });

  it('a fee larger than the amount is DISPUTED, never posted lopsided', async () => {
    const { svc, db, posts, alerts, notifications, deposit } = await setup();
    const id = await deposit('10.00', { fee: '20.00' });
    await expect(svc.processPayment(id)).resolves.toEqual({ outcome: 'DISPUTED', changed: true });
    expect(posts).toHaveLength(0);
    expect(db.rows('transaction')).toHaveLength(0);
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(alerts.raise).toHaveBeenCalledWith('NGN_RECONCILIATION', `disputed:${id}`, expect.any(String), expect.any(Array), expect.any(Number));
  });

  it('disputes a credited deposit that Payrep later calls failed or reversed, and claws nothing back', async () => {
    const { svc, db, payrep, posts, alerts, deposit } = await setup();
    const id = await deposit();
    await svc.processPayment(id);
    const real = payrep.fetchCredits.bind(payrep);
    jest.spyOn(payrep, 'fetchCredits').mockImplementation(async (f) => {
      const r = await real(f);
      return { ...r, items: r.items.map((c: PayrepCollection) => ({ ...c, status: 'reversed' })) };
    });
    await expect(svc.processPayment(id)).resolves.toEqual({ outcome: 'DISPUTED', changed: true });
    expect(posts).toHaveLength(1);
    expect(db.rows('transaction')[0].status).toBe('COMPLETED');
    expect(alerts.raise).toHaveBeenCalledWith('NGN_RECONCILIATION', `disputed:${id}`, expect.stringMatching(/reversed/), expect.any(Array), expect.any(Number));
  });

  it('disputes a credited deposit whose confirmed amount changes', async () => {
    const { svc, payrep, posts, deposit } = await setup();
    const id = await deposit();
    await svc.processPayment(id);
    const real = payrep.fetchCredits.bind(payrep);
    jest.spyOn(payrep, 'fetchCredits').mockImplementation(async (f) => {
      const r = await real(f);
      return { ...r, items: r.items.map((c: PayrepCollection) => ({ ...c, amount: '15000.00' })) };
    });
    await expect(svc.processPayment(id)).resolves.toEqual({ outcome: 'DISPUTED', changed: true });
    expect(posts).toHaveLength(1);
  });

  it('does nothing when a concurrent run won the unique reference', async () => {
    const { svc, db, posts, notifications, deposit } = await setup();
    const id = await deposit();
    db.failNext('transaction', 'create', p2002(['reference']));
    const real = db.serializable.bind(db);
    jest.spyOn(db, 'serializable').mockImplementationOnce((async (fn: never) => {
      try {
        return await real(fn);
      } catch (err) {
        await db.nairaCollection.updateMany({ where: { providerTransactionId: id }, data: { outcome: 'CREDITED' } });
        throw err;
      }
    }) as never);
    await expect(svc.processPayment(id)).resolves.toEqual({ outcome: 'CREDITED', changed: false });
    expect(posts).toHaveLength(0);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('retries (throws) when a conflict leaves the payment unsettled', async () => {
    const { svc, db, posts, deposit } = await setup();
    const id = await deposit();
    db.failNext('transaction', 'create', p2002(['reference']));
    await expect(svc.processPayment(id)).rejects.toThrow(/not settled/);
    expect(posts).toHaveLength(0);
    expect(db.rows('nairaCollection')[0].outcome).not.toBe('CREDITED');
  });

  // Three runs racing (Review Focus 5) is proved on real Postgres by scripts/prove-payrep-payin-race.ts:
  // this fake's transactions are not isolated, so it cannot model the race itself.

  it("credits, but flags, a deposit from someone whose name isn't the user's", async () => {
    const { svc, db, deposit } = await setup();
    await expect(svc.processPayment(await deposit('100.00', { senderName: 'JOHN DOE' }))).resolves.toMatchObject({ outcome: 'CREDITED' });
    expect(db.rows('transaction')[0]).toMatchObject({ nameMismatch: true, counterpartyName: 'JOHN DOE' });
  });

  it('credits a closed account as received, with a warning', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { svc, deposit } = await setup({ user: { status: 'CLOSED' } });
      await expect(svc.processPayment(await deposit())).resolves.toMatchObject({ outcome: 'CREDITED' });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/closed account/));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('PayInService.intake, enqueue and the worker', () => {
  it('intake records the hint once and queues a check; a repeat changes nothing', async () => {
    const { svc, db, queue } = await setup();
    const hint = { transactionId: 't1', accountNumber: ACC, referenceNumber: 'R1', createdAt: null, event: 'deposit.success' };
    await svc.intake(hint, 'WEBHOOK');
    await svc.intake({ ...hint, accountNumber: '2099999999' }, 'WEBHOOK');
    expect(db.rows('nairaCollection')).toEqual([expect.objectContaining({ providerTransactionId: 't1', outcome: 'UNVERIFIED', firstSource: 'WEBHOOK', accountNumber: ACC, referenceNumber: 'R1' })]);
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('queues webhook jobs under one id per payment, and sweep or re-check jobs under fresh ones', async () => {
    const { svc, queue } = await setup();
    await svc.enqueue('t9', 'WEBHOOK');
    await svc.enqueue('t9', 'SWEEP');
    await svc.enqueue('t9', 'RECHECK');
    const calls = queue.add.mock.calls as unknown as Array<[string, PayInJob, { jobId: string }]>;
    expect(calls[0]).toEqual([
      'process-naira-payin',
      { providerTransactionId: 't9', reason: 'WEBHOOK' },
      expect.objectContaining({ jobId: 'ngnin-t9', attempts: 8, backoff: { type: 'exponential', delay: 30_000 } }),
    ]);
    expect(calls[1][2].jobId).toMatch(/^ngnin-t9-sweep-\d+$/);
    expect(calls[2][2].jobId).toMatch(/^ngnin-t9-recheck-\d+$/);
  });

  it('the worker runs only its own job', async () => {
    const payIn = { processPayment: jest.fn(async () => ({ outcome: 'CREDITED', changed: true })) };
    const worker = new PayInProcessor(payIn as never);
    await expect(worker.process({ name: 'something-else', data: {} } as never)).resolves.toBeNull();
    await worker.process({ name: 'process-naira-payin', data: { providerTransactionId: 't1', reason: 'WEBHOOK' }, attemptsMade: 0 } as never);
    expect(payIn.processPayment.mock.calls).toEqual([['t1']]);
  });
});
