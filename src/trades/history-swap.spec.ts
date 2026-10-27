import { TxStatus, TxType } from '@prisma/client';

/**
 * Swap history (27 Oct 2026): a swap's fee is real and shown with its coin, and
 * a small rate (USDT → BTC ≈ 0.0000166) is shown with enough digits, never "0.0000".
 */
const swapRow = {
  id: 's1', type: TxType.SWAP, status: TxStatus.COMPLETED, fromAsset: 'usdt', fromAmount: '100', toAsset: 'btc', toAmount: '0.00166',
  displayedRate: '0.0000166', feeAmount: '0.0000166', feeAsset: 'btc', failureReason: null, createdAt: new Date(), completedAt: new Date(),
};
const buyRow = {
  id: 'b1', type: TxType.BUY, status: TxStatus.COMPLETED, fromAsset: 'ngn', fromAmount: '150000', toAsset: 'btc', toAmount: '0.0016',
  displayedRate: '1520.5', feeAmount: '0', feeAsset: null, failureReason: null, createdAt: new Date(), completedAt: new Date(),
};

async function svcWith(rows: unknown[]) {
  const { TradesService } = await import('./trades.service');
  const svc = Object.create(TradesService.prototype) as Record<string, unknown>;
  Object.assign(svc, { prisma: { transaction: { findMany: jest.fn(async () => rows), findFirst: jest.fn(async () => rows[0]) } } });
  return svc;
}

describe('Swap history shows the real fee and a readable rate', () => {
  it('the list: a swap shows its fee and coin; a small rate keeps its digits', async () => {
    const svc = await svcWith([swapRow]);
    const [row] = await (svc.history as (u: string) => Promise<Array<Record<string, unknown>>>).call(svc, 'u1');
    expect(row).toMatchObject({ fee: '0.0000166', feeAsset: 'btc', rate: '0.0000166' });
  });

  it('the list: buys and sells still show the fee as 0 (it lives inside the rate) and the rate with 4 decimals', async () => {
    const svc = await svcWith([buyRow]);
    const [row] = await (svc.history as (u: string) => Promise<Array<Record<string, unknown>>>).call(svc, 'u1');
    expect(row).toMatchObject({ fee: '0', rate: '1520.5000' });
  });

  it('one transaction: a swap includes its fee, coin and rate', async () => {
    const svc = await svcWith([swapRow]);
    const one = await (svc.get as (u: string, id: string) => Promise<Record<string, unknown>>).call(svc, 'u1', 's1');
    expect(one).toMatchObject({ fee: '0.0000166', feeAsset: 'btc', rate: '0.0000166' });
  });
});
