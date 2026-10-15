import { FeeClaimsService } from './fee-claims.service';
import { FeeClaimsProcessor } from './fee-claims.processor';

/**
 * H7 (PROJECT_REVIEW): a fee claim moves coins out of the customer's own
 * sub-account (swap, then transfer), and only afterwards marks the fee swept.
 * The sub-account also holds the customer's own coins. So a claim that fails
 * part-way must NEVER be run again automatically: a second swap or transfer
 * would be paid with the customer's money.
 *
 * Once a claim has started it either finishes or is parked for a person.
 */
function build(opts: { failAt?: 'swap' | 'transfer' | 'lookup'; assetCode?: string } = {}) {
  const row = {
    id: 'r1', userId: 'u1', assetCode: opts.assetCode ?? 'btc', amount: '0.001', sweptAt: null as Date | null,
    claimRunId: 'run1' as string | null, claimStartedAt: null as Date | null,
    asset: { transferMin: '0' },
  };
  const calls: string[] = [];
  const fail = (stage: string) => {
    if (opts.failAt === stage) throw new Error(`${stage} timed out`);
  };
  const prisma = {
    feeReceivable: {
      findUnique: jest.fn(async () => ({ ...row })),
      findUniqueOrThrow: jest.fn(async () => ({ ...row })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => (Object.assign(row, data), { ...row })),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if ('claimStartedAt' in where && row.claimStartedAt !== null) return { count: 0 };
        if ('sweptAt' in where && row.sweptAt !== null) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    feeClaimRun: {
      update: jest.fn(async () => ({})),
      findUniqueOrThrow: jest.fn(async () => ({ succeededCount: 0, failedCount: 0, totalCount: 5 })),
    },
  };
  const quidax = {
    createSwapQuotation: jest.fn(async () => (calls.push('quote'), { id: 'q1' })),
    confirmSwap: jest.fn(async () => (calls.push('swap'), fail('swap'), { received_amount: '60' })),
    internalTransfer: jest.fn(async () => (calls.push('transfer'), fail('transfer'), {})),
    newReference: jest.fn(() => 'feeclaim-random'),
  };
  const settlement = {
    quidaxIdFor: jest.fn(async () => (fail('lookup'), 'sub1')),
    mainAccount: jest.fn(async () => 'main'),
  };
  const config = { get: () => 'usdt' };
  const svc = new FeeClaimsService(prisma as never, quidax as never, settlement as never, {} as never, config as never, { add: jest.fn() } as never);
  const processor = new FeeClaimsProcessor(svc);
  const job = (attemptsMade = 0) =>
    ({ name: 'claim-fee', data: { runId: 'run1', receivableId: 'r1' }, attemptsMade, opts: { attempts: 8 } }) as never;
  return { svc, processor, job, row, calls, prisma, quidax };
}

describe('H7: a fee claim that fails part-way is never repeated automatically', () => {
  it('a normal claim swaps once, transfers once and marks the fee swept', async () => {
    const { processor, job, row, calls } = build();
    await processor.process(job());
    expect(calls).toEqual(['quote', 'swap', 'transfer']);
    expect(row.sweptAt).not.toBeNull();
  });

  it('a failure after the swap is not retried: no second swap from the customer’s coins', async () => {
    const { processor, job, row, calls } = build({ failAt: 'transfer' });
    // First attempt fails at the transfer. The worker must not ask for a retry...
    await expect(processor.process(job(0))).resolves.toBeDefined();
    // ...and even if a retry arrives anyway, it must not touch Quidax again.
    await processor.process(job(1));
    expect(calls.filter((c) => c === 'swap')).toHaveLength(1);
    expect(row.sweptAt).toBeNull();
  });

  it('a claim that failed part-way is parked, not released for the next run', async () => {
    const { processor, job, row } = build({ failAt: 'swap' });
    await processor.process(job(0));
    expect(row.claimRunId).toBe('run1');
    expect(row.claimStartedAt).not.toBeNull();
  });

  it('a failure before anything was sent can still be retried and released', async () => {
    const { processor, job, row, calls } = build({ failAt: 'lookup' });
    await expect(processor.process(job(7))).rejects.toThrow('lookup timed out');
    expect(calls).toEqual([]);
    expect(row.claimRunId).toBeNull();
    expect(row.claimStartedAt).toBeNull();
  });

  it('uses a fixed transfer reference per fee, so the transfer can be looked up later', async () => {
    const { processor, job, quidax } = build();
    await processor.process(job());
    expect(quidax.internalTransfer).toHaveBeenCalledWith(
      'sub1',
      expect.objectContaining({ reference: 'feeclaim-r1' }),
      'background',
    );
  });
});
