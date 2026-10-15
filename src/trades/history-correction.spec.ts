import { TxStatus, TxType } from '@prisma/client';

describe('A balance correction in the customer\'s history', () => {
  it('reads "Balance correction" and never shows the owner\'s reason', async () => {
    const { TradesService } = await import('./trades.service');
    const svc = Object.create(TradesService.prototype) as Record<string, unknown>;
    const findMany = jest.fn(async () => [
      { id: 'a1', type: TxType.ADJUSTMENT, status: TxStatus.COMPLETED, toAsset: 'btc', toAmount: '0.002', fromAsset: null, fromAmount: null, adjustmentReason: 'secret note', createdAt: new Date(), completedAt: new Date() },
    ]);
    Object.assign(svc, { prisma: { transaction: { findMany } } });
    const [row] = (await (svc.history as (u: string) => Promise<Array<Record<string, unknown>>>).call(svc, 'u1'));
    expect(row).toMatchObject({ type: 'ADJUSTMENT', label: 'Balance correction', toAsset: 'btc' });
    expect(JSON.stringify(row)).not.toContain('secret note');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ type: { in: expect.arrayContaining([TxType.ADJUSTMENT]) } }) }));
  });
});
