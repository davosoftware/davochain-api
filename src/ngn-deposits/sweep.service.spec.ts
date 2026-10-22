import { PayrepError } from '../payrep/payrep.errors';
import type { PayrepCollection } from '../payrep/payrep.types';
import { SweepService } from './sweep.service';
import { FakePrisma } from './testing/fake-prisma';

const OURS = '2012345678';
const MINUTE = 60_000;

function setup() {
  const db = new FakePrisma();
  const payrep = { fetchCredits: jest.fn() };
  const payIn = { enqueue: jest.fn(async () => undefined), intake: jest.fn(async () => undefined) };
  const leases = {
    run: jest.fn(async (_name: string, _ttl: number, fn: () => Promise<unknown>) => ({ ran: true, result: await fn() })),
  };
  const alerts = { raise: jest.fn(async () => true) };
  const svc = new SweepService(db as never, payrep as never, payIn as never, leases as never, alerts as never);
  return { db, payrep, payIn, leases, alerts, svc };
}

const credit = (id: string, over: Partial<PayrepCollection> = {}): PayrepCollection => ({
  transactionId: id, referenceNumber: `R${id}`, sessionId: null, status: 'success', amount: '1500.00', fee: '0.00', channel: 'bank_transfer',
  createdAt: '2026-10-07T10:00:00Z', accountNumber: OURS, transactionType: 'credit', payerName: 'A', payerBankName: 'B', payerAccountMasked: null, payerAccountNumber: null, payerBankCode: null, ...over,
});

async function ourAccount(db: FakePrisma) {
  await db.virtualAccount.create({ data: { userId: 'u1', accountNumber: OURS, accountName: 'A', bankName: 'Payrep MFB', source: 'CREATED' } });
}

describe('SweepService.sweep', () => {
  it('reads every page and hands on only unsettled credits into our accounts', async () => {
    const { db, payrep, payIn, svc } = setup();
    await ourAccount(db);
    await db.nairaCollection.create({ data: { providerTransactionId: '4', firstSource: 'WEBHOOK', outcome: 'CREDITED' } });
    payrep.fetchCredits
      .mockResolvedValueOnce({ items: [credit('1'), credit('2', { accountNumber: '2099999999' }), credit('3', { accountNumber: null })], next: { createdAt: 'c', id: '3' } })
      .mockResolvedValueOnce({ items: [credit('4')], next: null });
    await expect(svc.sweep(new Date('2026-10-07T12:00:00Z'))).resolves.toEqual({ status: 'OK', pages: 2, seen: 4, queued: 1, error: null });
    expect(payIn.intake.mock.calls).toEqual([
      [{ transactionId: '1', accountNumber: OURS, referenceNumber: 'R1', createdAt: '2026-10-07T10:00:00Z', event: 'sweep' }, 'SWEEP'],
    ]);
    expect(payrep.fetchCredits.mock.calls[1][1]).toEqual({ createdAt: 'c', id: '3' });
  });

  it('asks for credits from two days back to one ahead', async () => {
    const { payrep, svc } = setup();
    payrep.fetchCredits.mockResolvedValue({ items: [], next: null });
    await svc.sweep(new Date('2026-10-07T12:00:00Z'));
    expect(payrep.fetchCredits).toHaveBeenCalledWith({ startDate: '2026-10-05', endDate: '2026-10-08' }, null);
  });

  it('a page that comes back with the same cursor ends the run as PARTIAL, not a loop (final review I2)', async () => {
    const { payrep, svc } = setup();
    payrep.fetchCredits.mockResolvedValue({ items: [], next: { createdAt: 'c', id: 'same' } });
    await expect(svc.sweep()).resolves.toMatchObject({ status: 'PARTIAL', pages: 2, error: expect.stringMatching(/same page/) });
  });

  it('stops at the page limit and says the run was partial', async () => {
    const { payrep, svc } = setup();
    let n = 0;
    payrep.fetchCredits.mockImplementation(async () => ({ items: [], next: { createdAt: 'c', id: String(++n) } }));
    await expect(svc.sweep()).resolves.toMatchObject({ status: 'PARTIAL', pages: 100 });
    expect(payrep.fetchCredits).toHaveBeenCalledTimes(100);
  });

  it('keeps what it found when a page fails, and calls the run partial', async () => {
    const { db, payrep, payIn, svc } = setup();
    await ourAccount(db);
    payrep.fetchCredits
      .mockResolvedValueOnce({ items: [credit('1')], next: { createdAt: 'c', id: '1' } })
      .mockRejectedValueOnce(new PayrepError('UNCLEAR', 'timeout', 0, null));
    await expect(svc.sweep()).resolves.toEqual({ status: 'PARTIAL', pages: 1, seen: 1, queued: 1, error: 'timeout' });
    expect(payIn.intake).toHaveBeenCalledTimes(1);
  });

  it('alerts when Payrep refuses our keys', async () => {
    const { payrep, alerts, svc } = setup();
    payrep.fetchCredits.mockRejectedValue(new PayrepError('CONFIG', 'Unauthorized - invalid API credentials', 200, '41'));
    await expect(svc.sweep()).resolves.toMatchObject({ status: 'PARTIAL' });
    expect(alerts.raise).toHaveBeenCalledWith('NAIRA_RAIL_CONFIG', 'config', expect.any(String), expect.any(Array));
  });

  it('stops at the wall-clock budget and reports PARTIAL', async () => {
    const { payrep, svc } = setup();
    payrep.fetchCredits.mockResolvedValue({ items: [], next: { createdAt: 'c', id: 'x' } });
    const nowSpy = jest.spyOn(Date, 'now');
    let callCount = 0;
    nowSpy.mockImplementation(() => (++callCount === 1 ? 0 : 21 * MINUTE));
    try {
      const result = await svc.sweep();
      expect(result.status).toBe('PARTIAL');
      expect(result.pages).toBeLessThan(5);
      expect(result.error).toContain('20-minute budget');
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('SweepService.recheck', () => {
  it('re-queues payments still unverified or pending after ten minutes, for up to eight days', async () => {
    const { db, payIn, svc } = setup();
    const now = new Date('2026-10-07T12:00:00Z');
    const ago = (minutes: number) => new Date(now.getTime() - minutes * MINUTE);
    const rows: Array<[string, string, Date, Date | null]> = [
      ['a', 'UNVERIFIED', ago(30), null], //           queued: never checked, seen 30 min ago
      ['b', 'PENDING_PROVIDER', ago(60), ago(20)], //  queued: checked 20 min ago
      ['c', 'UNVERIFIED', ago(2), null], //            skipped: the webhook job is on it
      ['d', 'PENDING_PROVIDER', ago(60), ago(5)], //   skipped: checked 5 min ago
      ['e', 'UNVERIFIED', ago(9 * 24 * 60), null], //  skipped: older than 8 days
      ['f', 'CREDITED', ago(60), ago(30)], //          skipped: settled
    ];
    for (const [id, outcome, firstSeenAt, lastCheckedAt] of rows) {
      await db.nairaCollection.create({ data: { providerTransactionId: id, firstSource: 'WEBHOOK', outcome, firstSeenAt, lastCheckedAt } });
    }
    await expect(svc.recheck(now)).resolves.toEqual({ queued: 2 });
    expect(payIn.enqueue.mock.calls).toEqual([
      ['b', 'RECHECK'],
      ['a', 'RECHECK'],
    ]);
  });

  it('keeps looking for NOT_FOUND payments every 6 hours, up to eight days (final review I3)', async () => {
    const { db, payIn, svc } = setup();
    const now = new Date('2026-10-07T12:00:00Z');
    const ago = (minutes: number) => new Date(now.getTime() - minutes * MINUTE);
    const rows: Array<[string, Date, Date | null]> = [
      ['nf-old-check', ago(3 * 24 * 60), ago(7 * 60)], //  queued: last looked 7 h ago
      ['nf-recent', ago(3 * 24 * 60), ago(60)], //         skipped: looked an hour ago
      ['nf-ancient', ago(9 * 24 * 60), ago(7 * 60)], //    skipped: older than 8 days
    ];
    for (const [id, firstSeenAt, lastCheckedAt] of rows) {
      await db.nairaCollection.create({ data: { providerTransactionId: id, firstSource: 'WEBHOOK', outcome: 'NOT_FOUND', firstSeenAt, lastCheckedAt } });
    }
    await expect(svc.recheck(now)).resolves.toEqual({ queued: 1 });
    expect(payIn.enqueue.mock.calls).toEqual([['nf-old-check', 'RECHECK']]);
  });
});

describe('SweepService crons', () => {
  it('skips the sweep until the rail is in use, and runs every job under its lease', async () => {
    const { db, payrep, leases, svc } = setup();
    payrep.fetchCredits.mockResolvedValue({ items: [], next: null });
    await svc.sweepCron();
    expect(payrep.fetchCredits).not.toHaveBeenCalled();

    await db.virtualAccountRequest.create({ data: { userId: 'u1', state: 'IDLE' } });
    await svc.sweepCron();
    await svc.recheckCron();
    expect(payrep.fetchCredits).toHaveBeenCalledTimes(1);
    expect(leases.run.mock.calls.map((c) => c[0])).toEqual(['naira-sweep', 'naira-recheck']);
  });

  it('alerts after two consecutive partial sweeps, not after one', async () => {
    const { db, payrep, alerts, svc } = setup();
    payrep.fetchCredits.mockRejectedValue(new Error('connection reset'));
    await db.virtualAccountRequest.create({ data: { userId: 'u1', state: 'IDLE' } });
    await svc.sweepCron();
    expect(alerts.raise).not.toHaveBeenCalled();
    await svc.sweepCron();
    expect(alerts.raise).toHaveBeenCalledWith('NGN_RECONCILIATION', 'naira-sweep-partial', expect.any(String), expect.any(Array));
  });

  it('a complete sweep resets the partial count', async () => {
    const { db, payrep, alerts, svc } = setup();
    await db.virtualAccountRequest.create({ data: { userId: 'u1', state: 'IDLE' } });
    payrep.fetchCredits.mockRejectedValueOnce(new Error('fail'));
    await svc.sweepCron();
    payrep.fetchCredits.mockResolvedValueOnce({ items: [], next: null });
    await svc.sweepCron();
    payrep.fetchCredits.mockRejectedValueOnce(new Error('fail'));
    await svc.sweepCron();
    expect(alerts.raise).not.toHaveBeenCalled();
  });
});
