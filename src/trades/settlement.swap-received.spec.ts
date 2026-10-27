import { AlertType, TxStatus, TxType } from '@prisma/client';
import { SettlementService } from './settlement.service';

/**
 * Swap completion (27 Oct 2026): the customer is credited what Quidax actually
 * delivered into their sub-account, minus our fee, so our books always match
 * custody. With the live-quotation pricing that equals the quote; if it ever
 * doesn't, the actual amount wins and a person is told.
 */
function build(tx: Record<string, unknown>) {
  let row = { ...tx };
  const credits: Array<{ assetCode: string; amount: string }> = [];
  const t = {
    transaction: {
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (row.status === TxStatus.COMPLETED) return { count: 0 };
        row = { ...row, ...data };
        return { count: 1 };
      }),
    },
    rateSnapshot: { findFirst: jest.fn(async () => ({ priceUsd: '1' })) },
    swapFee: { create: jest.fn(async () => ({})) },
    feeReceivable: { create: jest.fn(async () => ({})) },
  };
  const prisma = {
    transaction: { findUniqueOrThrow: jest.fn(async () => ({ ...row })) },
    serializable: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(t)),
  };
  const ledger = {
    settleLocked: jest.fn(async () => undefined),
    credit: jest.fn(async (_t: unknown, c: { assetCode: string; amount: { toFixed(): string } }) => credits.push({ assetCode: c.assetCode, amount: c.amount.toFixed() })),
  };
  const notifications = { notify: jest.fn(async () => undefined) };
  const alerts = { raise: jest.fn(async () => true) };
  const svc = new SettlementService(prisma as never, {} as never, ledger as never, notifications as never, {} as never, { evaluate: async () => undefined } as never, alerts as never);
  return { svc, credits, alerts, notifications, row: () => row, t };
}

const SWAP = {
  id: 'tx1', userId: 'u1', type: TxType.SWAP, status: TxStatus.PROCESSING,
  fromAsset: 'btc', fromAmount: '1', toAsset: 'usdt', toAmount: '58999', feeAmount: '1', feeAsset: 'usdt', rateConfigId: 'cfg1',
};

describe('Swap completion credits what Quidax delivered, minus our fee', () => {
  it('Quidax delivered exactly the quoted amount: credited as quoted, no alert', async () => {
    const b = build(SWAP);
    await b.svc.finaliseSwap('tx1', '59000');
    expect(b.credits).toEqual([{ assetCode: 'usdt', amount: '58999' }]);
    expect(b.alerts.raise).not.toHaveBeenCalled();
  });

  it('Quidax delivered less: the customer is credited what arrived minus the fee, the record says so, and a person is told', async () => {
    const b = build(SWAP);
    await b.svc.finaliseSwap('tx1', '58900');
    expect(b.credits).toEqual([{ assetCode: 'usdt', amount: '58899' }]);
    expect(b.row()).toMatchObject({ status: TxStatus.COMPLETED, toAmount: '58899' });
    expect(b.alerts.raise).toHaveBeenCalledWith(AlertType.RECONCILIATION_DRIFT, 'swap-amount:tx1', expect.any(String), expect.any(Array), expect.any(Number));
    expect(JSON.stringify(b.notifications.notify.mock.calls[0])).toContain('58899');
  });

  it('Quidax delivered more: the customer gets it (never less than arrived, never more)', async () => {
    const b = build(SWAP);
    await b.svc.finaliseSwap('tx1', '59100');
    expect(b.credits).toEqual([{ assetCode: 'usdt', amount: '59099' }]);
  });

  it('rounding dust (the quote is rounded down to the smallest unit of the coin; Quidax delivers the exact amount): the exact amount is credited, and nobody is alerted', async () => {
    const b = build(SWAP);
    await b.svc.finaliseSwap('tx1', '59000.0000004');
    expect(b.credits).toEqual([{ assetCode: 'usdt', amount: '58999.0000004' }]);
    expect(b.row()).toMatchObject({ toAmount: '58999.0000004' });
    expect(b.alerts.raise).not.toHaveBeenCalled();
  });

  it('no delivered amount known (an owner resolved it by hand): credited as quoted', async () => {
    const b = build(SWAP);
    await b.svc.finaliseSwap('tx1');
    expect(b.credits).toEqual([{ assetCode: 'usdt', amount: '58999' }]);
    expect(b.alerts.raise).not.toHaveBeenCalled();
  });

  it('an amount Quidax sent that cannot be read is treated as unknown (quoted), never as zero', async () => {
    const b = build(SWAP);
    await b.svc.finaliseSwap('tx1', 'not-a-number');
    expect(b.credits).toEqual([{ assetCode: 'usdt', amount: '58999' }]);
  });
});
