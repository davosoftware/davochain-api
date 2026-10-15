import { TxStatus } from '@prisma/client';
import { DepositsService } from './deposits.service';

/**
 * C2 (PROJECT_REVIEW): a deposit is credited exactly once.
 *
 * Quidax re-sends webhooks, the gap sweep re-reads the deposit list, and the
 * worker runs several jobs at once, so the same deposit arriving twice at the
 * same moment is normal. The fake below models what Postgres gives us:
 * `serializable` closures behave as if run one after another, and a closure
 * that throws leaves nothing behind (rollback). Every call yields, so requests
 * genuinely interleave.
 */
const tick = () => new Promise((r) => setImmediate(r));
type Row = { id: string; reference: string; status: TxStatus; completedAt: Date | null; [k: string]: unknown };

function build() {
  const rows = new Map<string, Row>();
  let seq = 0;
  const byId = (id: string) => [...rows.values()].find((r) => r.id === id);
  const statusOk = (r: Row, where: any) =>
    !where.status || (where.status.notIn ? !where.status.notIn.includes(r.status) : where.status === r.status);

  const transaction = {
    findUnique: jest.fn(async ({ where }: any) => {
      await tick();
      const r = where.reference ? rows.get(where.reference) : byId(where.id);
      return r ? { ...r } : null;
    }),
    findUniqueOrThrow: jest.fn(async ({ where }: any) => {
      await tick();
      const r = rows.get(where.reference);
      if (!r) throw new Error('not found');
      return { ...r };
    }),
    create: jest.fn(async ({ data }: any) => {
      await tick();
      if (rows.has(data.reference)) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
      const r: Row = { id: `tx${++seq}`, completedAt: null, ...data };
      rows.set(r.reference, r);
      return { ...r };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      await tick();
      const r = byId(where.id)!;
      Object.assign(r, data);
      return { ...r };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      await tick();
      const r = byId(where.id);
      if (!r || !statusOk(r, where)) return { count: 0 };
      Object.assign(r, data);
      return { count: 1 };
    }),
  };

  const credits: Array<{ transactionId: string; amount: string }> = [];
  const ledger = {
    failNext: false,
    credit: jest.fn(async (_t: unknown, input: { transactionId: string; amount: { toFixed(): string } }) => {
      await tick();
      if (ledger.failNext) {
        ledger.failNext = false;
        throw new Error('database blip');
      }
      credits.push({ transactionId: input.transactionId, amount: input.amount.toFixed() });
    }),
  };

  // One closure at a time, all-or-nothing: the observable result of SERIALIZABLE.
  let chain: Promise<unknown> = Promise.resolve();
  const serializable = jest.fn((fn: (t: unknown) => Promise<unknown>) => {
    const run = chain.then(async () => {
      const snapshot = new Map([...rows].map(([k, v]) => [k, { ...v }]));
      const creditsBefore = credits.length;
      try {
        return await fn({ transaction });
      } catch (err) {
        rows.clear();
        snapshot.forEach((v, k) => rows.set(k, v));
        credits.length = creditsBefore;
        throw err;
      }
    });
    chain = run.catch(() => undefined);
    return run;
  });

  const prisma = {
    transaction,
    serializable,
    user: { findUnique: jest.fn(async () => ({ kycTier: 'TIER_1' })) },
    asset: { findUnique: jest.fn(async () => ({ code: 'btc', displayScale: 8 })) },
  };
  const provisioning = { findUserByQuidax: jest.fn(async () => 'user-1') };
  const notifications = { notify: jest.fn(async () => undefined) };
  const rates = { price: jest.fn(async () => ({ priceUsd: '60000', ngnPerUsd: '1500' })) };
  const limits = { check: jest.fn(async () => ({ allowed: true })) };
  const svc = new DepositsService(prisma as never, ledger as never, provisioning as never, notifications as never, rates as never, limits as never);
  return { svc, rows, credits, ledger, notifications };
}

const deposit = (status = 'accepted', over: Record<string, unknown> = {}) =>
  ({
    id: 'dep-1',
    type: 'coin_address',
    currency: 'btc',
    amount: '0.5',
    fee: '0',
    txid: '0xabc',
    status,
    reason: null,
    user: { id: 'qx-sub-1', sn: 'QDX1' },
    ...over,
  }) as never;

describe('C2: a deposit is credited exactly once', () => {
  it('credits a confirmed deposit once and marks it completed', async () => {
    const { svc, rows, credits } = build();
    await svc.applyWebhook('deposit.successful', deposit());
    expect(credits).toEqual([{ transactionId: 'tx1', amount: '0.5' }]);
    expect(rows.get('quidax_deposit_dep-1')!.status).toBe(TxStatus.COMPLETED);
  });

  it('credits once when the same deposit arrives twice at the same moment', async () => {
    const { svc, rows, credits } = build();
    await Promise.all([
      svc.applyWebhook('deposit.successful', deposit()),
      svc.applyWebhook('deposit.successful', deposit()),
    ]);
    expect(credits).toHaveLength(1);
    expect(rows.size).toBe(1);
  });

  it('credits once when a deposit first seen as pending is confirmed twice at the same moment', async () => {
    const { svc, credits } = build();
    await svc.applyWebhook('deposit.transaction.confirmation', deposit('submitted'));
    await Promise.all([
      svc.applyWebhook('deposit.successful', deposit()),
      svc.applyWebhook('deposit.successful', deposit()),
    ]);
    expect(credits).toHaveLength(1);
  });

  it('credits once when the webhook and the gap sweep deliver it together', async () => {
    const { svc, credits } = build();
    await Promise.all([svc.applyWebhook('deposit.successful', deposit()), svc.sweepGaps([deposit()] as never)]);
    expect(credits).toHaveLength(1);
  });

  it('never leaves a deposit "completed" without the money: a failed credit can be retried', async () => {
    const { svc, rows, credits, ledger } = build();
    ledger.failNext = true;
    await expect(svc.applyWebhook('deposit.successful', deposit())).rejects.toThrow('database blip');
    expect(rows.get('quidax_deposit_dep-1')?.status).not.toBe(TxStatus.COMPLETED);
    expect(credits).toHaveLength(0);

    // Quidax re-sends; this time the credit lands.
    await svc.applyWebhook('deposit.successful', deposit());
    expect(credits).toHaveLength(1);
    expect(rows.get('quidax_deposit_dep-1')!.status).toBe(TxStatus.COMPLETED);
  });

  it('a pending deposit is recorded, then credited once it is confirmed', async () => {
    const { svc, rows, credits } = build();
    await svc.applyWebhook('deposit.transaction.confirmation', deposit('submitted'));
    expect(rows.get('quidax_deposit_dep-1')!.status).toBe(TxStatus.PENDING);
    expect(credits).toHaveLength(0);
    await svc.applyWebhook('deposit.successful', deposit());
    expect(credits).toHaveLength(1);
  });
});
