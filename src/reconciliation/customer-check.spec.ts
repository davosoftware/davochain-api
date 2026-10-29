import { NotFoundException } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';

/**
 * One customer, every coin (29 Oct 2026): their recorded balance, the same
 * figure rebuilt from their ledger entries, and what Quidax holds for them,
 * so a discrepancy can be traced to the side that is wrong.
 */
type Entry = { assetCode: string; direction: 'CREDIT' | 'DEBIT'; amount: string };

function build(o: {
  user?: { id: string; firstName: string; lastName: string; email: string } | null;
  balances?: Array<{ assetCode: string; available: string; locked: string }>;
  entries?: Entry[];
  fees?: Array<{ assetCode: string; amount: string }>;
  quidaxUserId?: string | null;
  held?: Array<{ currency: string; balance: string }> | Error;
  open?: Array<{ id: string; type: string; status: string; createdAt: Date; fromAsset: string | null; toAsset: string | null }>;
}) {
  const prisma = {
    user: {
      findUnique: jest.fn(async () =>
        o.user === undefined ? { id: 'u1', firstName: 'Ada', lastName: 'Obi', email: 'ada@x.com' } : o.user,
      ),
    },
    asset: { findMany: jest.fn(async () => [{ code: 'ngn', isFiat: true }, { code: 'usdt', isFiat: false }, { code: 'btc', isFiat: false }]) },
    balance: { findMany: jest.fn(async () => o.balances ?? []) },
    ledgerEntry: {
      groupBy: jest.fn(async () => {
        const sums = new Map<string, number>();
        for (const e of o.entries ?? []) {
          const k = `${e.assetCode}|${e.direction}`;
          sums.set(k, (sums.get(k) ?? 0) + Number(e.amount));
        }
        return [...sums].map(([k, v]) => {
          const [assetCode, direction] = k.split('|');
          return { assetCode, direction, _sum: { amount: String(v) } };
        });
      }),
    },
    feeReceivable: { findMany: jest.fn(async () => o.fees ?? []) },
    quidaxAccount: { findUnique: jest.fn(async () => (o.quidaxUserId === null ? null : { quidaxUserId: o.quidaxUserId ?? 'qx-1' })) },
    transaction: { findMany: jest.fn(async () => o.open ?? []) },
  };
  const quidax = {
    fetchWallets: jest.fn(async () => {
      if (o.held instanceof Error) throw o.held;
      return o.held ?? [];
    }),
  };
  // quidaxIdFor would CREATE a Quidax account for a customer without one: a check must never do that.
  const settlement = { quidaxIdFor: jest.fn(async () => { throw new Error('must not be called'); }) };
  const svc = new ReconciliationService(prisma as never, quidax as never, {} as never, settlement as never, {} as never, {} as never);
  return { svc, prisma, quidax, settlement };
}

const credit = (assetCode: string, amount: string): Entry => ({ assetCode, direction: 'CREDIT', amount });
const debit = (assetCode: string, amount: string): Entry => ({ assetCode, direction: 'DEBIT', amount });

describe('Balance check for one customer', () => {
  it('everything agrees: recorded = rebuilt from entries = held at Quidax', async () => {
    const { svc, settlement } = build({
      balances: [{ assetCode: 'usdt', available: '70', locked: '30' }],
      entries: [credit('usdt', '150'), debit('usdt', '50')],
      held: [{ currency: 'usdt', balance: '100' }],
    });
    const r = await svc.customerCheck('u1');
    expect(r).toMatchObject({ userId: 'u1', name: 'Ada Obi', email: 'ada@x.com', quidax: 'READ' });
    expect(r.rows).toEqual([
      expect.objectContaining({
        asset: 'usdt', available: '70', locked: '30', recorded: '100', fromEntries: '100', entriesMatch: true,
        uncollectedFees: '0', held: '100', difference: '0', verdict: 'OK',
      }),
    ]);
    expect(settlement.quidaxIdFor).not.toHaveBeenCalled();
  });

  it('Quidax holds less than our records and nothing is in flight: UNEXPLAINED, with the difference', async () => {
    const { svc } = build({
      balances: [{ assetCode: 'usdt', available: '50', locked: '0' }],
      entries: [credit('usdt', '50')],
      held: [{ currency: 'usdt', balance: '20' }],
    });
    const [row] = (await svc.customerCheck('u1')).rows;
    expect(row).toMatchObject({ held: '20', difference: '30', verdict: 'UNEXPLAINED' });
  });

  it('a balance that does not match its own entries is flagged before anything else', async () => {
    const { svc } = build({
      balances: [{ assetCode: 'btc', available: '0.5', locked: '0' }],
      entries: [credit('btc', '0.3')],
      held: [{ currency: 'btc', balance: '0.5' }],
    });
    const [row] = (await svc.customerCheck('u1')).rows;
    expect(row).toMatchObject({ recorded: '0.5', fromEntries: '0.3', entriesMatch: false, verdict: 'RECORDS_DISAGREE' });
  });

  it('a difference with a transaction still going is IN_PROGRESS, and BEING_CHECKED when one is reconciling', async () => {
    const open = [{ id: 't1', type: 'WITHDRAWAL', status: 'PROCESSING', createdAt: new Date(), fromAsset: 'usdt', toAsset: 'usdt' }];
    const one = build({
      balances: [{ assetCode: 'usdt', available: '0', locked: '10' }],
      entries: [credit('usdt', '10')],
      held: [{ currency: 'usdt', balance: '0' }],
      open,
    });
    const [row] = (await one.svc.customerCheck('u1')).rows;
    expect(row).toMatchObject({ verdict: 'IN_PROGRESS', open: [expect.objectContaining({ id: 't1', status: 'PROCESSING' })] });

    const two = build({
      balances: [{ assetCode: 'usdt', available: '0', locked: '10' }],
      entries: [credit('usdt', '10')],
      held: [{ currency: 'usdt', balance: '0' }],
      open: [{ ...open[0], status: 'RECONCILING' }],
    });
    expect((await two.svc.customerCheck('u1')).rows[0].verdict).toBe('BEING_CHECKED');
  });

  it('uncollected fees count on our side, as in the coin-wide check', async () => {
    const { svc } = build({
      balances: [{ assetCode: 'usdt', available: '10', locked: '0' }],
      entries: [credit('usdt', '10')],
      fees: [{ assetCode: 'usdt', amount: '0.5' }],
      held: [{ currency: 'usdt', balance: '10.5' }],
    });
    expect((await svc.customerCheck('u1')).rows[0]).toMatchObject({ uncollectedFees: '0.5', difference: '0', verdict: 'OK' });
  });

  it('coins Quidax holds that our records never heard of still show', async () => {
    const { svc } = build({ held: [{ currency: 'btc', balance: '0.01' }] });
    expect((await svc.customerCheck('u1')).rows).toEqual([
      expect.objectContaining({ asset: 'btc', recorded: '0', held: '0.01', difference: '-0.01', verdict: 'UNEXPLAINED' }),
    ]);
  });

  it('naira is not held at Quidax, so only the records are compared', async () => {
    const { svc } = build({
      balances: [{ assetCode: 'ngn', available: '5000', locked: '0' }],
      entries: [credit('ngn', '5000')],
      held: [{ currency: 'ngn', balance: '999' }],
    });
    expect((await svc.customerCheck('u1')).rows).toEqual([
      expect.objectContaining({ asset: 'ngn', held: null, difference: null, entriesMatch: true, verdict: 'OK' }),
    ]);
  });

  it('Quidax unreadable or no Quidax account: nothing is claimed missing', async () => {
    const down = build({ balances: [{ assetCode: 'usdt', available: '5', locked: '0' }], entries: [credit('usdt', '5')], held: new Error('timeout') });
    const r = await down.svc.customerCheck('u1');
    expect(r.quidax).toBe('UNREADABLE');
    expect(r.rows[0]).toMatchObject({ held: null, difference: null, verdict: 'NOT_CHECKED' });

    const none = build({ balances: [{ assetCode: 'usdt', available: '5', locked: '0' }], entries: [credit('usdt', '5')], quidaxUserId: null });
    const n = await none.svc.customerCheck('u1');
    expect(n.quidax).toBe('NO_ACCOUNT');
    expect(none.quidax.fetchWallets).not.toHaveBeenCalled();
    expect(n.rows[0].verdict).toBe('NOT_CHECKED');
  });

  it('a difference below the tolerance (rounding dust) is reported as none', async () => {
    const { svc } = build({
      balances: [{ assetCode: 'usdt', available: '100', locked: '0' }],
      entries: [credit('usdt', '100')],
      held: [{ currency: 'usdt', balance: '100.000000000000002109' }],
    });
    expect((await svc.customerCheck('u1')).rows[0]).toMatchObject({ difference: '0', verdict: 'OK' });
  });

  it('an unknown customer is a 404', async () => {
    const { svc } = build({ user: null });
    await expect(svc.customerCheck('nobody')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('coins at zero everywhere are left out', async () => {
    const { svc } = build({
      balances: [{ assetCode: 'btc', available: '0', locked: '0' }],
      entries: [credit('btc', '1'), debit('btc', '1')],
      held: [{ currency: 'btc', balance: '0' }],
    });
    expect((await svc.customerCheck('u1')).rows).toEqual([]);
  });
});
