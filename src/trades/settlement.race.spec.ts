import { TxStatus, TxType } from '@prisma/client';
import { SettlementService } from './settlement.service';

/**
 * H6 (PROJECT_REVIEW): a transaction is closed exactly once.
 *
 * A webhook, its re-delivery and the 30-minute reconciler can all try to
 * finish the same withdrawal or swap at the same moment. Each of them used to
 * check "already done?" before its write and never again inside it, so two
 * could both settle: a withdrawal eating other locked funds, a swap crediting
 * the output coin twice, a refund unlocking twice.
 *
 * The fake models Postgres SERIALIZABLE: closures behave as if run one after
 * another and roll back on error. Every call yields, so callers interleave.
 */
const tick = () => new Promise((r) => setImmediate(r));
type Tx = { id: string; userId: string; type: TxType; status: TxStatus; reference: string; fromAsset: string; fromAmount: string; toAsset?: string; toAmount?: string | null; feeAmount?: string | null; feeAsset?: string | null; rateConfigId?: string | null; networkFee?: string | null };

function build(tx: Tx) {
  const rows = new Map<string, Tx>([[tx.id, { ...tx }]]);
  const open = (where: any, r: Tx) =>
    !where.status || (where.status.in ? where.status.in.includes(r.status) : where.status === r.status);

  const transaction = {
    findFirst: jest.fn(async ({ where }: any) => {
      await tick();
      const r = [...rows.values()].find((x) => x.reference === where.reference);
      return r ? { ...r } : null;
    }),
    findUniqueOrThrow: jest.fn(async ({ where }: any) => {
      await tick();
      return { ...rows.get(where.id)! };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      await tick();
      Object.assign(rows.get(where.id)!, data);
      return { ...rows.get(where.id)! };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      await tick();
      const r = rows.get(where.id);
      if (!r || !open(where, r)) return { count: 0 };
      Object.assign(r, data);
      return { count: 1 };
    }),
  };
  const settlementLeg = {
    findUnique: jest.fn(async () => (await tick(), null)),
    findFirst: jest.fn(async () => (await tick(), { id: 'leg1', transaction: { ...rows.get(tx.id)! } })),
    update: jest.fn(async () => (await tick(), {})),
  };

  const moves: string[] = [];
  const fees: string[] = [];
  const swapFee = { create: jest.fn(async () => (await tick(), fees.push('swapFee'))) };
  const feeReceivable = { create: jest.fn(async () => (await tick(), fees.push('receivable'))) };
  const rateSnapshot = { findFirst: jest.fn(async () => (await tick(), { priceUsd: '3000' })) };
  const record = (name: string) => jest.fn(async () => (await tick(), moves.push(name)));
  const ledger = {
    settleLockedWithEntries: record('settle-withdrawal'),
    unlock: record('unlock'),
    settleLocked: record('settle-locked'),
    credit: record('credit'),
  };

  let chain: Promise<unknown> = Promise.resolve();
  const serializable = jest.fn((fn: (t: unknown) => Promise<unknown>) => {
    const run = chain.then(async () => {
      const snapshot = new Map([...rows].map(([k, v]) => [k, { ...v }]));
      const movesBefore = moves.length;
      const feesBefore = fees.length;
      try {
        return await fn({ transaction, settlementLeg, swapFee, feeReceivable, rateSnapshot });
      } catch (err) {
        rows.clear();
        snapshot.forEach((v, k) => rows.set(k, v));
        moves.length = movesBefore;
        fees.length = feesBefore;
        throw err;
      }
    });
    chain = run.catch(() => undefined);
    return run;
  });

  const notifications = { notify: jest.fn(async () => undefined) };
  const prisma = { transaction, settlementLeg, serializable };
  const svc = new SettlementService(prisma as never, {} as never, ledger as never, notifications as never, {} as never, { evaluate: async () => undefined } as never);
  return { svc, rows, moves, fees, notifications, status: () => rows.get(tx.id)!.status };
}

const withdrawal: Tx = {
  id: 'tx1', userId: 'u1', type: TxType.WITHDRAWAL, status: TxStatus.PROCESSING, reference: 'dvc_wd_1',
  fromAsset: 'btc', fromAmount: '0.5', toAmount: '0.49', feeAmount: '0.01', networkFee: '0',
};
const swap: Tx = {
  id: 'tx2', userId: 'u1', type: TxType.SWAP, status: TxStatus.PROCESSING, reference: 'dvc_sw_1',
  fromAsset: 'btc', fromAmount: '0.5', toAsset: 'eth', toAmount: '10', feeAmount: '0.02', feeAsset: 'eth', rateConfigId: 'cfg1',
};
const qxWithdrawal = (status = 'Done') => ({ id: 'qx1', reference: 'dvc_wd_1', status, fee: '0', txid: '0xabc', reason: null }) as never;

describe('H6: a transaction is closed exactly once', () => {
  it('a withdrawal confirmed twice at the same moment is settled once', async () => {
    const { svc, moves, notifications, status } = build(withdrawal);
    await Promise.all([
      svc.applyWithdrawalWebhook('withdraw.successful', qxWithdrawal()),
      svc.applyWithdrawalWebhook('withdraw.successful', qxWithdrawal()),
    ]);
    expect(moves).toEqual(['settle-withdrawal']);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(status()).toBe(TxStatus.COMPLETED);
  });

  it('a withdrawal reported both sent and rejected at once ends one way only', async () => {
    const { svc, moves } = build(withdrawal);
    await Promise.all([
      svc.applyWithdrawalWebhook('withdraw.successful', qxWithdrawal()),
      svc.applyWithdrawalWebhook('withdraw.rejected', qxWithdrawal('Rejected')),
    ]);
    expect(moves).toHaveLength(1);
  });

  it('a withdrawal rejected twice at once unlocks the funds once', async () => {
    const { svc, moves } = build(withdrawal);
    await Promise.all([
      svc.applyWithdrawalWebhook('withdraw.rejected', qxWithdrawal('Rejected')),
      svc.applyWithdrawalWebhook('withdraw.rejected', qxWithdrawal('Rejected')),
    ]);
    expect(moves).toEqual(['unlock']);
  });

  it('a swap finalised twice at the same moment credits the output coin once', async () => {
    const { svc, moves, status } = build(swap);
    await Promise.all([svc.finaliseSwap('tx2'), svc.finaliseSwap('tx2')]);
    expect(moves.filter((m) => m === 'credit')).toHaveLength(1);
    expect(status()).toBe(TxStatus.COMPLETED);
  });

  it('a swap completion webhook delivered twice credits once', async () => {
    const { svc, moves } = build(swap);
    const event = { id: 'qs1', status: 'completed' } as never;
    await Promise.all([
      svc.applySwapWebhook('swap_transaction.completed', event),
      svc.applySwapWebhook('swap_transaction.completed', event),
    ]);
    expect(moves.filter((m) => m === 'credit')).toHaveLength(1);
  });

  it('a refund triggered twice at the same moment unlocks once', async () => {
    const { svc, moves, notifications } = build(swap);
    await Promise.all([svc.reverse('tx2', 'failed'), svc.reverse('tx2', 'failed')]);
    expect(moves).toEqual(['unlock']);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
  });

  it('marking "being checked" never re-opens a finished transaction', async () => {
    const { svc, rows, status } = build(withdrawal);
    rows.get('tx1')!.status = TxStatus.COMPLETED;
    await svc.markReconciling('tx1', 'late error');
    expect(status()).toBe(TxStatus.COMPLETED);
  });
});

describe('H6: a buy or sell is settled only while it is still open', () => {
  async function trades(status: TxStatus) {
    const { TradesService } = await import('./trades.service');
    const moves: string[] = [];
    const t = {
      transaction: {
        updateMany: jest.fn(async () => ({ count: ([TxStatus.PENDING, TxStatus.PROCESSING, TxStatus.RECONCILING] as TxStatus[]).includes(status) ? 1 : 0 })),
        update: jest.fn(async () => ({})),
        findUniqueOrThrow: jest.fn(async () => ({ status })),
      },
    };
    const svc = Object.create(TradesService.prototype) as Record<string, unknown>;
    Object.assign(svc, {
      prisma: { serializable: (fn: (x: unknown) => unknown) => fn(t), transaction: t.transaction },
      ledger: { settleLocked: jest.fn(async () => moves.push('settle')), credit: jest.fn(async () => moves.push('credit')) },
      notifications: { notify: jest.fn(async () => undefined) },
      referrals: { evaluate: jest.fn(async () => undefined) },
    });
    const { dec } = await import('../common/money');
    const settle = (svc.settle as (...a: unknown[]) => Promise<{ status: TxStatus }>).bind(svc);
    const result = await settle('tx9', 'u1', { fromAsset: 'ngn', toAsset: 'btc', displayedRate: '1500' }, dec('1000'), dec('0.0001'), 'INVENTORY');
    return { moves, result, notify: (svc.notifications as { notify: jest.Mock }).notify };
  }

  it('settles an open trade', async () => {
    const { moves, result } = await trades(TxStatus.PROCESSING);
    expect(moves).toEqual(['settle', 'credit']);
    expect(result.status).toBe(TxStatus.COMPLETED);
  });

  it('moves no money and sends nothing for a trade something else already closed', async () => {
    const { moves, result, notify } = await trades(TxStatus.FAILED);
    expect(moves).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(result.status).toBe(TxStatus.FAILED);
  });
});

describe('H2: a swap fee is booked only when the swap completes', () => {
  it('a completed swap books its fee once, even when completed twice at once', async () => {
    const { svc, fees } = build(swap);
    await Promise.all([svc.finaliseSwap('tx2'), svc.finaliseSwap('tx2')]);
    expect(fees).toEqual(['swapFee', 'receivable']);
  });

  it('a failed (refunded) swap books no fee', async () => {
    const { svc, fees } = build(swap);
    await svc.reverse('tx2', 'The swap could not be completed');
    await svc.finaliseSwap('tx2');
    expect(fees).toEqual([]);
  });

  it('starting a swap books no fee', async () => {
    const { TradesService } = await import('./trades.service');
    const created: string[] = [];
    const svc = Object.create(TradesService.prototype) as Record<string, unknown>;
    Object.assign(svc, {
      flags: { assertTradingAllowed: jest.fn(async () => undefined) },
      settlement: { quidaxIdFor: jest.fn(async () => 'sub1'), swapInSubAccount: jest.fn(async () => undefined) },
      ledger: { lock: jest.fn() },
      quidax: { newReference: () => 'ref' },
      prisma: {
        serializable: jest.fn(async () => ({ id: 'tx3' })),
        transaction: { update: jest.fn(async () => ({})) },
        rateSnapshot: { findFirst: jest.fn(async () => ({ priceUsd: '3000' })) },
        swapFee: { create: jest.fn(() => created.push('swapFee')) },
        feeReceivable: { create: jest.fn(() => created.push('receivable')) },
        $transaction: jest.fn(async () => created.push('batch')),
      },
    });
    const swapFn = (svc.swap as (...a: unknown[]) => Promise<{ status: TxStatus }>).bind(svc);
    const result = await swapFn('u1', {
      id: 'q1', fromAsset: 'btc', toAsset: 'eth', fromAmount: '0.5', toAmount: '10', displayedRate: '20',
      usdValue: null, feeUsd: null, feeAmount: '0.02', feeAsset: 'eth', rateConfigId: 'cfg1',
    });
    expect(result.status).toBe(TxStatus.PROCESSING);
    expect(created).toEqual([]);
  });
});

describe('H4: the reconciler finishes a buy exactly once', () => {
  const buy: Tx = {
    id: 'tx5', userId: 'u1', type: TxType.BUY, status: TxStatus.RECONCILING, reference: 'dvc_buy_1',
    fromAsset: 'ngn', fromAmount: '100000', toAsset: 'btc', toAmount: '0.001',
  };

  it('completeTrade run twice at once settles once', async () => {
    const { svc, moves, status } = build(buy);
    const results = await Promise.all([svc.completeTrade('tx5'), svc.completeTrade('tx5')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(moves).toEqual(['settle-locked', 'credit']);
    expect(status()).toBe(TxStatus.COMPLETED);
  });

  it('completeTrade leaves a refunded trade alone', async () => {
    const { svc, rows, moves } = build(buy);
    rows.get('tx5')!.status = TxStatus.FAILED;
    expect(await svc.completeTrade('tx5')).toBe(false);
    expect(moves).toEqual([]);
  });
});

describe('H4: a crypto withdrawal fee is recorded as owed to us', () => {
  it('the platform fee left in the sub-account becomes a fee receivable', async () => {
    const { svc, fees } = build(withdrawal);
    await svc.applyWithdrawalWebhook('withdraw.successful', qxWithdrawal());
    expect(fees).toEqual(['receivable']);
  });

  it('a withdrawal confirmed twice records the fee once', async () => {
    const { svc, fees } = build(withdrawal);
    await Promise.all([
      svc.applyWithdrawalWebhook('withdraw.successful', qxWithdrawal()),
      svc.applyWithdrawalWebhook('withdraw.successful', qxWithdrawal()),
    ]);
    expect(fees).toEqual(['receivable']);
  });
});
