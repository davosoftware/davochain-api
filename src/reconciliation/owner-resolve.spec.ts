import { AdminRole, LegState, TxStatus, TxType } from '@prisma/client';
import { ReconciliationService } from './reconciliation.service';

/**
 * H4 (PROJECT_REVIEW): some RECONCILING transactions cannot be decided by the
 * reconciler (a swap whose confirm never answered, a trade half done). They
 * need a person: an OWNER, with a written note, through the same run-once
 * paths the automatic flow uses.
 */
function build(tx: { id: string; type: TxType; status: TxStatus; reference?: string }) {
  const done: string[] = [];
  const legUpdates: Array<Record<string, unknown>> = [];
  const prisma = {
    transaction: { findUnique: jest.fn(async () => ({ userId: 'u1', networkFee: '0', quidaxRef: null, reference: 'ref', ...tx })) },
    settlementLeg: { updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => (legUpdates.push(data), { count: 1 })) },
  };
  const settlement = {
    applyWithdrawalWebhook: jest.fn(async () => done.push('withdrawal-completed')),
    completeTrade: jest.fn(async () => (done.push('trade-completed'), true)),
    finaliseSwap: jest.fn(async () => done.push('swap-completed')),
    reverse: jest.fn(async (_id: string, reason: string) => done.push(`refund: ${reason}`)),
  };
  const svc = new ReconciliationService(prisma as never, {} as never, {} as never, settlement as never, {} as never, {} as never);
  return { svc, done, legUpdates };
}
const owner = { id: 'o1', role: AdminRole.OWNER };
const sub = { id: 's1', role: AdminRole.SUB_ADMIN };
const NOTE = 'Checked Quidax: transfer dvc_xfer_1 shows Done at 10:42.';

describe('H4: an owner resolves a transaction the reconciler cannot', () => {
  it('only an owner may resolve', async () => {
    const { svc, done } = build({ id: 'tx1', type: TxType.BUY, status: TxStatus.RECONCILING });
    await expect(svc.resolveByOwner(sub, 'tx1', 'COMPLETED', NOTE)).rejects.toMatchObject({ status: 403 });
    expect(done).toEqual([]);
  });

  it('a written note is required', async () => {
    const { svc } = build({ id: 'tx1', type: TxType.BUY, status: TxStatus.RECONCILING });
    await expect(svc.resolveByOwner(owner, 'tx1', 'COMPLETED', 'ok')).rejects.toMatchObject({ status: 400 });
  });

  it('only a transaction that is being checked can be resolved', async () => {
    const { svc } = build({ id: 'tx1', type: TxType.BUY, status: TxStatus.COMPLETED });
    await expect(svc.resolveByOwner(owner, 'tx1', 'FAILED', NOTE)).rejects.toMatchObject({ status: 409 });
  });

  it.each([
    [TxType.BUY, 'trade-completed'],
    [TxType.SELL, 'trade-completed'],
    [TxType.SWAP, 'swap-completed'],
    [TxType.WITHDRAWAL, 'withdrawal-completed'],
  ])('completing a %s uses its normal settle path and closes its open legs', async (type, expected) => {
    const { svc, done, legUpdates } = build({ id: 'tx1', type, status: TxStatus.RECONCILING });
    await svc.resolveByOwner(owner, 'tx1', 'COMPLETED', NOTE);
    expect(done).toEqual([expected]);
    expect(legUpdates).toContainEqual(expect.objectContaining({ state: LegState.CONFIRMED }));
  });

  it('failing it refunds through the normal path, with the note as the reason', async () => {
    const { svc, done, legUpdates } = build({ id: 'tx1', type: TxType.WITHDRAWAL, status: TxStatus.RECONCILING });
    await svc.resolveByOwner(owner, 'tx1', 'FAILED', NOTE);
    expect(done).toEqual([`refund: Resolved by an owner: ${NOTE}`]);
    expect(legUpdates).toContainEqual(expect.objectContaining({ state: LegState.FAILED }));
  });
});
