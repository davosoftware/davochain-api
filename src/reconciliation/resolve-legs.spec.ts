import { LegState, SettlementLegKind, TxStatus, TxType } from '@prisma/client';
import { ReconciliationService } from './reconciliation.service';
import { OPEN_STATUSES } from '../trades/close-open';

/**
 * H4 (PROJECT_REVIEW): the 30-minute reconciler must actually FINISH what it
 * resolves.
 *  - a buy/sell whose legs are all confirmed upstream is settled (the user's
 *    funds were otherwise locked forever);
 *  - a swap leg is looked up as a swap, never as a withdrawal;
 *  - a failed leg refunds only when nothing else of the trade went out;
 *  - legs left PENDING (a crash) are checked too, oldest first.
 */
type Leg = { id: string; transactionId: string; kind: SettlementLegKind; state: LegState; reference: string; quidaxRef: string | null; amount: string; updatedAt: Date };
type Tx = { id: string; userId: string; type: TxType; status: TxStatus; fromAmount: string; toAmount: string };

function build(txs: Tx[], legs: Leg[], upstream: { withdrawals?: Record<string, string>; swaps?: Record<string, string> } = {}) {
  const legRows = legs.map((l) => ({ ...l }));
  const txRows = new Map(txs.map((t) => [t.id, { ...t }]));
  const done: string[] = [];
  const prisma = {
    settlementLeg: {
      findMany: jest.fn(async ({ where, orderBy }: any) => {
        if (where.transactionId) return legRows.filter((l) => l.transactionId === where.transactionId).map((l) => ({ ...l }));
        return legRows
          .filter((l) => [LegState.UNKNOWN, LegState.SENT, LegState.PENDING].includes(l.state as never))
          .sort((a, b) => (orderBy ? a.updatedAt.getTime() - b.updatedAt.getTime() : 0))
          .map((l) => ({ ...l, transaction: { ...txRows.get(l.transactionId)! } }));
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(legRows.find((l) => l.id === where.id)!, data)),
    },
    transaction: { findUnique: jest.fn(async ({ where }: any) => ({ ...txRows.get(where.id)! })) },
  };
  const quidax = {
    fetchWithdrawalByReference: jest.fn(async (ref: string) =>
      upstream.withdrawals?.[ref] ? { id: `qx-${ref}`, reference: ref, status: upstream.withdrawals[ref] } : null,
    ),
    fetchSwapTransactions: jest.fn(async () =>
      Object.entries(upstream.swaps ?? {}).map(([id, status]) => ({ id, status })),
    ),
  };
  const settlement = {
    quidaxIdFor: jest.fn(async () => 'sub1'),
    applyWithdrawalWebhook: jest.fn(async () => done.push('withdrawal-webhook')),
    reverse: jest.fn(async (id: string) => done.push(`refund:${id}`)),
    finaliseSwap: jest.fn(async (id: string) => done.push(`finalise-swap:${id}`)),
    completeTrade: jest.fn(async (id: string) => done.push(`complete:${id}`)),
  };
  const svc = new ReconciliationService(prisma as never, quidax as never, {} as never, settlement as never, {} as never, {} as never);
  return { svc, done, legRows, quidax, prisma };
}

const old = new Date(Date.now() - 3_600_000);
const leg = (over: Partial<Leg>): Leg => ({
  id: 'l1', transactionId: 'tx1', kind: SettlementLegKind.TRANSFER_OUT, state: LegState.UNKNOWN, reference: 'ref1',
  quidaxRef: null, amount: '0.001', updatedAt: old, ...over,
});
const trade = (over: Partial<Tx> = {}): Tx => ({
  id: 'tx1', userId: 'u1', type: TxType.BUY, status: TxStatus.RECONCILING, fromAmount: '100000', toAmount: '0.002', ...over,
});

describe('H4: the reconciler finishes what it resolves', () => {
  it('settles a buy once every transfer leg is confirmed upstream', async () => {
    const { svc, done } = build(
      [trade()],
      [leg({ id: 'l1', reference: 'r1', state: LegState.CONFIRMED }), leg({ id: 'l2', reference: 'r2' })],
      { withdrawals: { r2: 'Done' } },
    );
    await svc.resolveStuckLegs();
    expect(done).toEqual(['complete:tx1']);
  });

  it('does not settle while a leg is still open', async () => {
    const { svc, done } = build(
      [trade()],
      [leg({ id: 'l1', reference: 'r1' }), leg({ id: 'l2', reference: 'r2' })],
      { withdrawals: { r2: 'Done' } },
    );
    await svc.resolveStuckLegs();
    expect(done).toEqual([]);
  });

  it('a failed leg does not refund a trade when another of its legs went out', async () => {
    const { svc, done } = build(
      [trade()],
      [leg({ id: 'l1', reference: 'r1', state: LegState.CONFIRMED }), leg({ id: 'l2', reference: 'r2' })],
      { withdrawals: { r2: 'Rejected' } },
    );
    await svc.resolveStuckLegs();
    expect(done).toEqual([]);
  });

  it('a failed leg refunds a trade when nothing else of it went out', async () => {
    const { svc, done } = build(
      [trade({ type: TxType.SELL, fromAmount: '0.002', toAmount: '3000' })],
      [leg({ kind: SettlementLegKind.TRANSFER_IN })],
      { withdrawals: { ref1: 'Rejected' } },
    );
    await svc.resolveStuckLegs();
    expect(done).toEqual(['refund:tx1']);
  });

  it('looks a swap leg up as a swap, and completes the swap', async () => {
    const { svc, done, quidax } = build(
      [trade({ type: TxType.SWAP, status: TxStatus.PROCESSING })],
      [leg({ kind: SettlementLegKind.SWAP, state: LegState.SENT, quidaxRef: 'sw1' })],
      { swaps: { sw1: 'completed' } },
    );
    await svc.resolveStuckLegs();
    expect(quidax.fetchWithdrawalByReference).not.toHaveBeenCalled();
    expect(done).toEqual(['finalise-swap:tx1']);
  });

  it('refunds a swap that failed upstream', async () => {
    const { svc, done } = build(
      [trade({ type: TxType.SWAP, status: TxStatus.PROCESSING })],
      [leg({ kind: SettlementLegKind.SWAP, state: LegState.SENT, quidaxRef: 'sw1' })],
      { swaps: { sw1: 'failed' } },
    );
    await svc.resolveStuckLegs();
    expect(done).toEqual(['refund:tx1']);
  });

  it('also checks legs left PENDING (a crash), oldest first', async () => {
    const { svc, prisma } = build([trade()], [leg({ state: LegState.PENDING })]);
    await svc.resolveStuckLegs();
    const query = prisma.settlementLeg.findMany.mock.calls[0][0];
    expect(JSON.stringify(query.where)).toContain('PENDING');
    expect(query.orderBy).toEqual({ updatedAt: 'asc' });
  });

  it('only open transactions are considered settled-able', () => {
    expect(OPEN_STATUSES).toEqual([TxStatus.PENDING, TxStatus.PROCESSING, TxStatus.RECONCILING]);
  });
});
