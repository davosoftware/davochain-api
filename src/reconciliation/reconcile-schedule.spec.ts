import { ReconciliationService } from './reconciliation.service';

/** M10 (PROJECT_REVIEW): the 30-minute reconciliation ran on every server copy. */
describe('M10: reconciliation runs on one server only', () => {
  it('the scheduled run takes the "reconcile" lease and keeps it until it expires', async () => {
    const runs: Array<{ name: string; keep?: boolean }> = [];
    const leases = {
      run: jest.fn(async (name: string, _ttl: number, _fn: () => Promise<unknown>, opts?: { keep?: boolean }) => {
        runs.push({ name, keep: opts?.keep });
        return { ran: false };
      }),
    };
    const svc = new ReconciliationService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, leases as never);
    await svc.scheduled();
    expect(runs).toEqual([{ name: 'reconcile', keep: true }]);
  });
});
