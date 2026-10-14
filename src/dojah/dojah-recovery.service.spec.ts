import { DojahRecoveryService } from './dojah-recovery.service';

const lease = { run: jest.fn(async (_n: string, _t: number, fn: () => Promise<unknown>) => ({ ran: true, result: await fn() })) };

describe('DojahRecoveryService', () => {
  it('fails stale lookups, marks stale screens unknown, then sends what is due, in that order', async () => {
    const order: string[] = [];
    const basic = { failStaleLookups: jest.fn(async () => (order.push('lookups'), 2)) };
    const aml = {
      markStaleInFlight: jest.fn(async () => (order.push('stale'), 1)),
      dueRetries: jest.fn(async () => (order.push('due'), ['s1', 's2'])),
      send: jest.fn(async (id: string) => void order.push(`send:${id}`)),
    };
    const svc = new DojahRecoveryService(lease as never, basic as never, aml as never, {} as never, { raise: jest.fn() } as never);
    expect(await svc.tick()).toEqual({ lookupsFailed: 2, screensUnknown: 1, retried: 2 });
    expect(order).toEqual(['lookups', 'stale', 'due', 'send:s1', 'send:s2']);
    expect(lease.run).toHaveBeenCalledWith('dojah-recovery', 110_000, expect.any(Function));
  });

  it('one failing send does not stop the others', async () => {
    const aml = { markStaleInFlight: async () => 0, dueRetries: async () => ['a', 'b'], send: jest.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(undefined) };
    const svc = new DojahRecoveryService(lease as never, { failStaleLookups: async () => 0 } as never, aml as never, {} as never, { raise: jest.fn() } as never);
    expect((await svc.tick()).retried).toBe(1);
  });

  it('does nothing when another server holds the lease', async () => {
    const busy = { run: jest.fn(async () => ({ ran: false })) };
    const basic = { failStaleLookups: jest.fn() };
    const svc = new DojahRecoveryService(busy as never, basic as never, {} as never, {} as never, { raise: jest.fn() } as never);
    expect(await svc.tick()).toEqual({ lookupsFailed: 0, screensUnknown: 0, retried: 0 });
    expect(basic.failStaleLookups).not.toHaveBeenCalled();
  });

  it('lists unknown and possibly-charged calls for billing reconciliation, with no identity data', async () => {
    const prisma = {
      kycVerification: { findMany: jest.fn(async () => [{ id: 'v1', userId: 'u1', lookupStartedAt: new Date('2026-10-14T10:00:00Z'), lookupOutcome: 'UNKNOWN', possiblyCharged: true, idHash: 'h1:secret', idLast4: '2222' }]) },
      amlScreening: { findMany: jest.fn(async () => [{ id: 's1', userId: 'u1', screenStartedAt: new Date('2026-10-14T10:01:00Z'), callOutcome: 'SUCCEEDED', possibleDuplicateCharge: true, entityId: 'e1', inputs: { names: 'John' } }]) },
    };
    const svc = new DojahRecoveryService(lease as never, {} as never, {} as never, prisma as never, { raise: jest.fn() } as never);
    const rows = await svc.unknownCalls();
    expect(rows).toEqual([
      { kind: 'LOOKUP', id: 'v1', userId: 'u1', at: '2026-10-14T10:00:00.000Z', outcome: 'UNKNOWN', possiblyCharged: true, possibleDuplicateCharge: false, entityId: null },
      { kind: 'AML', id: 's1', userId: 'u1', at: '2026-10-14T10:01:00.000Z', outcome: 'SUCCEEDED', possiblyCharged: true, possibleDuplicateCharge: true, entityId: 'e1' },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/secret|2222|John/);
  });

  it('the weekly digest alerts only when there is something to reconcile', async () => {
    const alerts = { raise: jest.fn(async () => true) };
    const empty = { kycVerification: { findMany: async () => [] }, amlScreening: { findMany: async () => [] } };
    await new DojahRecoveryService(lease as never, {} as never, {} as never, empty as never, alerts as never).weeklyDigest();
    expect(alerts.raise).not.toHaveBeenCalled();
  });
});
