import { FlutterwaveError, FlutterwaveUnknownError } from '../flutterwave/flutterwave.errors';
import type { ListTransactionsQuery } from '../flutterwave/flutterwave.types';
import { SweepService } from './sweep.service';
import { FakePrisma } from './testing/fake-prisma';

const TX_REF = 'dcva_7f3c2a1b9e8d4c6fa1b2c3d4e5f60718';
const MINUTE = 60_000;

function setup() {
  const db = new FakePrisma();
  const client = { listTransactions: jest.fn() };
  const payIn = { enqueue: jest.fn(async () => undefined) };
  const accounts = { syncStatuses: jest.fn(async () => ({ checked: 0, fixed: 0, failing: 0 })) };
  const leases = {
    run: jest.fn(async (_name: string, _ttl: number, fn: () => Promise<unknown>) => ({ ran: true, result: await fn() })),
  };
  const alerts = { raise: jest.fn(async () => true) };
  const svc = new SweepService(db as never, client as never, payIn as never, accounts as never, leases as never, alerts as never);
  return { db, client, payIn, accounts, leases, alerts, svc };
}

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id, tx_ref: TX_REF, payment_type: 'bank_transfer', status: 'successful', amount: '1500', ...over,
});

describe('SweepService.sweep', () => {
  it('reads every page and queues only our unsettled bank-transfer payments', async () => {
    const { db, client, payIn, svc } = setup();
    client.listTransactions.mockImplementation(async (q: ListTransactionsQuery) =>
      q.page === 1
        ? { items: [item('1'), item('2', { payment_type: 'card' }), item('3', { tx_ref: 'dcbt_someone_else' })], totalPages: 2 }
        : { items: [item('4'), item('x/1')], totalPages: 2 },
    );
    await db.flutterwaveCollection.create({ data: { flwTransactionId: '4', firstSource: 'WEBHOOK', outcome: 'CREDITED' } });

    await expect(svc.sweep(new Date('2026-10-07T12:00:00Z'))).resolves.toEqual({ status: 'OK', pages: 2, seen: 5, queued: 1, error: null });
    expect(payIn.enqueue.mock.calls).toEqual([['1', 'SWEEP']]);
    expect(db.rows('flutterwaveCollection').map((r) => [r.flwTransactionId, r.firstSource, r.outcome])).toEqual([
      ['4', 'WEBHOOK', 'CREDITED'],
      ['1', 'SWEEP', 'UNVERIFIED'],
    ]);
  });

  it('asks for successful NGN payments from two Lagos days back to one ahead', async () => {
    const { client, svc } = setup();
    client.listTransactions.mockResolvedValue({ items: [], totalPages: 0 });
    await svc.sweep(new Date('2026-10-07T23:30:00Z')); // already 8 October in Lagos
    expect(client.listTransactions).toHaveBeenCalledWith({
      from: '2026-10-06', to: '2026-10-09', page: 1, status: 'successful', currency: 'NGN',
    });
  });

  it('stops at 500 pages and says the run was partial', async () => {
    const { client, svc } = setup();
    client.listTransactions.mockResolvedValue({ items: [], totalPages: 1000 });
    await expect(svc.sweep()).resolves.toMatchObject({ status: 'PARTIAL', pages: 500 });
    expect(client.listTransactions).toHaveBeenCalledTimes(500);
  });

  it('keeps what it found when a page fails, and calls the run partial', async () => {
    const { client, payIn, svc } = setup();
    client.listTransactions
      .mockResolvedValueOnce({ items: [item('1')], totalPages: 3 })
      .mockRejectedValueOnce(new FlutterwaveUnknownError('timeout', 'GET', '/transactions'));
    await expect(svc.sweep()).resolves.toEqual({ status: 'PARTIAL', pages: 1, seen: 1, queued: 1, error: 'timeout' });
    expect(payIn.enqueue).toHaveBeenCalledTimes(1);
  });

  it('alerts when Flutterwave refuses our key', async () => {
    const { client, alerts, svc } = setup();
    client.listTransactions.mockRejectedValue(new FlutterwaveError('CONFIG', 'Authorization required', 401));
    await expect(svc.sweep()).resolves.toMatchObject({ status: 'PARTIAL' });
    expect(alerts.raise).toHaveBeenCalledWith('FLUTTERWAVE_CONFIG', 'config', expect.any(String), expect.any(Array));
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
      await db.flutterwaveCollection.create({ data: { flwTransactionId: id, firstSource: 'WEBHOOK', outcome, firstSeenAt, lastCheckedAt } });
    }
    await expect(svc.recheck(now)).resolves.toEqual({ queued: 2 });
    expect(payIn.enqueue.mock.calls).toEqual([
      ['b', 'RECHECK'],
      ['a', 'RECHECK'],
    ]);
  });
});

describe('SweepService crons', () => {
  it('skips the sweep until the rail is in use, and runs every job under its lease', async () => {
    const { db, client, accounts, leases, svc } = setup();
    client.listTransactions.mockResolvedValue({ items: [], totalPages: 0 });
    await svc.sweepCron();
    expect(client.listTransactions).not.toHaveBeenCalled();

    await db.virtualAccountRequest.create({ data: { userId: 'u1', state: 'IDLE' } });
    await svc.sweepCron();
    await svc.recheckCron();
    await svc.syncCron();
    expect(client.listTransactions).toHaveBeenCalledTimes(1);
    expect(accounts.syncStatuses).toHaveBeenCalledTimes(1);
    expect(leases.run.mock.calls.map((c) => c[0])).toEqual(['flutterwave-sweep', 'flutterwave-recheck', 'virtual-account-sync']);
  });
});
