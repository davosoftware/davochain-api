import { ReconciliationService } from './reconciliation.service';

/**
 * The custody check compares what customers are owed with what their
 * sub-accounts hold, coin by coin.
 *
 * H4: comparing a PARTIAL "held" with the FULL "owed" reported missing money
 * that was not there. OPEN_ISSUES A2: the first fix then refused to report
 * ANY drift once there were more than 200 holders (or one unreadable one), so
 * the check went silent at scale. Now both sides cover exactly the customers
 * that were read, and the runs take turns through every holder.
 */
function build(holders: number, opts: { short?: string; unreadable?: string; cursor?: string } = {}) {
  const flags = new Map<string, unknown>(opts.cursor ? [['reconcile_cursor', opts.cursor]] : []);
  const prisma = {
    asset: { findMany: jest.fn(async () => [{ code: 'btc' }]) },
    balance: {
      findMany: jest.fn(async () =>
        Array.from({ length: holders }, (_, i) => ({ userId: `u${String(i).padStart(3, '0')}`, assetCode: 'btc', available: '0.01', locked: '0' })),
      ),
    },
    feeReceivable: { findMany: jest.fn(async () => []) },
    systemFlag: {
      findUnique: jest.fn(async ({ where }: { where: { key: string } }) => (flags.has(where.key) ? { key: where.key, value: flags.get(where.key) } : null)),
      upsert: jest.fn(async ({ where, create }: { where: { key: string }; create: { value: unknown } }) => void flags.set(where.key, create.value)),
    },
  };
  const scanned: string[] = [];
  const quidax = {
    fetchWallets: jest.fn(async (sub: string) => {
      const user = sub.replace('sub-', '');
      scanned.push(user);
      if (user === opts.unreadable) throw new Error('timeout');
      return [{ currency: 'btc', balance: user === opts.short ? '0.004' : '0.01' }];
    }),
  };
  const settlement = { quidaxIdFor: jest.fn(async (id: string) => `sub-${id}`) };
  const { dec } = jest.requireActual('../common/money');
  const ledger = { projectedTotals: jest.fn(async () => ({ userTotal: dec('0'), receivableTotal: dec('0'), lockedTotal: dec('0') })) };
  const svc = new ReconciliationService(prisma as never, quidax as never, ledger as never, settlement as never, {} as never, {} as never);
  return { svc, scanned, flags };
}

describe('The custody check measures what it reads, and only that', () => {
  it('every holder read and matching: no drift, not partial', async () => {
    const [row] = await build(5).svc.checkInvariants();
    expect(row).toMatchObject({ drift: '0', withinTolerance: true, partial: false, customersChecked: 5, customersHolding: 5 });
  });

  it('more holders than one run reads, all matching: no drift (and it says it checked 200 of 250)', async () => {
    const [row] = await build(250).svc.checkInvariants();
    expect(row).toMatchObject({ drift: '0', withinTolerance: true, partial: true, customersChecked: 200, customersHolding: 250 });
  });

  it('more than 200 holders and one of those read is short: the shortfall IS reported', async () => {
    const [row] = await build(250, { short: 'u010' }).svc.checkInvariants();
    expect(row.withinTolerance).toBe(false);
    expect(row.drift).toBe('0.006');
  });

  it('an unreadable customer is left out of both sides; a real shortfall elsewhere is still reported', async () => {
    const [ok] = await build(5, { unreadable: 'u002' }).svc.checkInvariants();
    expect(ok).toMatchObject({ drift: '0', withinTolerance: true, partial: true, customersChecked: 4 });
    const [bad] = await build(5, { unreadable: 'u002', short: 'u003' }).svc.checkInvariants();
    expect(bad.withinTolerance).toBe(false);
  });

  it('runs take turns: the next run starts after the last customer read, so every holder is checked', async () => {
    const b = build(250);
    await b.svc.checkInvariants();
    expect(b.scanned[0]).toBe('u000');
    expect(b.flags.get('reconcile_cursor')).toBe('u199');
    b.scanned.length = 0;
    await b.svc.checkInvariants();
    expect(b.scanned.slice(0, 50)).toEqual(Array.from({ length: 50 }, (_, i) => `u${String(200 + i).padStart(3, '0')}`));
    expect(b.scanned[50]).toBe('u000'); // wraps round to fill the 200
  });
});
