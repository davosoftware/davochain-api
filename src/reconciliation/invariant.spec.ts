import { ReconciliationService } from './reconciliation.service';

/**
 * H4 (PROJECT_REVIEW): the custody check compares what users are owed with what
 * their sub-accounts hold. It scans at most 200 sub-accounts per run; with more
 * holders it compared a partial "held" against the FULL "owed", and reported
 * drift (missing customer money) that was not there.
 */
function build(holders: number) {
  const prisma = {
    asset: { findMany: jest.fn(async () => [{ code: 'btc' }]) },
    balance: {
      findMany: jest.fn(async () =>
        Array.from({ length: holders }, (_, i) => ({ userId: `u${i}`, assetCode: 'btc', available: '0.01', locked: '0' })),
      ),
    },
    feeReceivable: { findMany: jest.fn(async () => []) },
  };
  const quidax = { fetchWallets: jest.fn(async () => [{ currency: 'btc', balance: '0.01' }]) };
  const settlement = { quidaxIdFor: jest.fn(async (id: string) => `sub-${id}`) };
  const { dec } = jest.requireActual('../common/money');
  const ledger = { projectedTotals: jest.fn(async () => ({ userTotal: dec('0'), receivableTotal: dec('0'), lockedTotal: dec('0') })) };
  return new ReconciliationService(prisma as never, quidax as never, ledger as never, settlement as never, {} as never, {} as never);
}

describe('H4: the custody check never reports drift it did not measure', () => {
  it('with every holder scanned and balances matching, there is no drift', async () => {
    const [row] = await build(5).checkInvariants();
    expect(row.drift).toBe('0');
    expect(row.withinTolerance).toBe(true);
    expect(row.partial).toBe(false);
  });

  it('with more holders than one run scans, the run is partial and claims no shortfall', async () => {
    const [row] = await build(201).checkInvariants();
    expect(row.partial).toBe(true);
    expect(row.withinTolerance).toBe(true);
  });
});
