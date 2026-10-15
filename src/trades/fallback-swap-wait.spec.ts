import { LegState, TxStatus } from '@prisma/client';
import { SettlementService } from './settlement.service';
import { QuidaxError, QuidaxUnknownError } from '../quidax/quidax.errors';

/**
 * H3 (PROJECT_REVIEW): when inventory is short, a buy first purchases the coin
 * on our main account (a "fallback swap"). Quidax answers "initiated"; the coin
 * arrives later. The buy used to move the coin to the customer straight away,
 * before our purchase had landed. It must wait for the swap to complete first.
 */
function settlement(statuses: string[]) {
  const svc = Object.create(SettlementService.prototype) as SettlementService;
  const seen = [...statuses];
  const legUpdates: Array<Record<string, unknown>> = [];
  Object.assign(svc, {
    quidax: {
      fetchSwapTransactions: jest.fn(async () => [
        { id: 'other', status: 'completed' },
        { id: 'sw1', status: seen.length > 1 ? seen.shift() : seen[0] },
      ]),
    },
    prisma: { settlementLeg: { updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => (legUpdates.push(data), { count: 1 })) } },
    pause: jest.fn(async () => undefined),
  });
  return { svc, legUpdates };
}

describe('H3: a fallback buy waits for our own purchase to land', () => {
  it('returns once the swap is completed, and confirms its leg', async () => {
    const { svc, legUpdates } = settlement(['initiated', 'initiated', 'completed']);
    await expect(svc.awaitSwap('sw1')).resolves.toBeUndefined();
    expect(legUpdates).toContainEqual(expect.objectContaining({ state: LegState.CONFIRMED }));
  });

  it('a failed swap is a definite failure (nothing happened, safe to refund)', async () => {
    const { svc, legUpdates } = settlement(['initiated', 'failed']);
    const err = await svc.awaitSwap('sw1').catch((e) => e);
    expect(err).toBeInstanceOf(QuidaxError);
    expect(legUpdates).toContainEqual(expect.objectContaining({ state: LegState.FAILED }));
  });

  it('a swap still not done after the wait is UNKNOWN (no refund, nothing moved)', async () => {
    const { svc } = settlement(['initiated']);
    await expect(svc.awaitSwap('sw1')).rejects.toBeInstanceOf(QuidaxUnknownError);
  });
});

describe('H3: the buy moves the coin only after the purchase landed', () => {
  async function buy(awaitSwap: () => Promise<void>) {
    const { TradesService } = await import('./trades.service');
    const order: string[] = [];
    const svc = Object.create(TradesService.prototype) as Record<string, unknown>;
    Object.assign(svc, {
      flags: { assertTradingAllowed: jest.fn(async () => undefined) },
      assets: { require: jest.fn(async () => ({ code: 'btc' })), chunkForTransfer: () => ['0.001'] },
      quidax: { newReference: () => 'buy-ref' },
      ledger: { lock: jest.fn() },
      inventory: { recordSale: jest.fn(async () => undefined) },
      prisma: {
        inventorySetting: { findUnique: jest.fn(async () => ({ fallbackSwapEnabled: true })) },
        serializable: jest.fn(async () => ({ id: 'tx1' })),
        settlementLeg: { count: jest.fn(async () => 1) },
      },
      settlement: {
        inventory: jest.fn(async () => ({ lt: () => true })),
        mainAccount: jest.fn(async () => 'main'),
        quidaxIdFor: jest.fn(async () => 'sub1'),
        fallbackSwap: jest.fn(async () => (order.push('swap'), { id: 'sw1', status: 'initiated', _leg: 'leg1' })),
        awaitSwap: jest.fn(async () => (order.push('wait'), awaitSwap())),
        transfer: jest.fn(async () => order.push('transfer')),
        isUnknown: (e: unknown) => !(e instanceof QuidaxError && e.httpStatus < 500),
        describe: (e: unknown) => (e as Error).message,
        internalReason: (e: unknown) => (e as Error).message,
        markReconciling: jest.fn(async () => order.push('reconciling')),
        reverse: jest.fn(async () => order.push('refund')),
      },
      settle: jest.fn(async () => (order.push('settle'), { status: TxStatus.COMPLETED })),
    });
    const run = (svc.buy as (...a: unknown[]) => Promise<{ status: TxStatus }>).bind(svc);
    const result = await run('u1', {
      id: 'q1', fromAsset: 'ngn', toAsset: 'btc', fromAmount: '100000', toAmount: '0.001', displayedRate: '1500',
      quidaxRate: '1500', usdValue: null, feeUsd: null, gateApplied: '0', rateConfigId: 'cfg1',
    }).catch((e: unknown) => e);
    return { order, result };
  }

  it('waits for the swap, then transfers and settles', async () => {
    const { order } = await buy(async () => undefined);
    expect(order).toEqual(['swap', 'wait', 'transfer', 'settle']);
  });

  it('never transfers while the swap has not landed', async () => {
    const { order, result } = await buy(async () => {
      throw new QuidaxUnknownError('swap still initiated', 'GET', '/swap_transactions');
    });
    expect(order).not.toContain('transfer');
    expect(order).toContain('reconciling');
    expect((result as { status: TxStatus }).status).toBe(TxStatus.RECONCILING);
  });
});
