import { AccountOpenerService } from './account-opener.service';

/** The background opener (spec 2026-10-23 §4.1): verified customers get their naira account without asking. */
function build(o: { users?: string[]; blocked?: Array<Record<string, unknown>>; ready?: boolean; autoOpen?: boolean } = {}) {
  const prisma = {
    user: { findMany: jest.fn(async () => (o.users ?? []).map((id) => ({ id }))) },
    virtualAccountRequest: { findMany: jest.fn(async () => o.blocked ?? []) },
  };
  const accounts = { ensure: jest.fn(async () => ({ httpStatus: 201 })) };
  const readiness = { report: jest.fn(async () => ({ depositsEnabled: o.ready ?? true, canCreateAccounts: o.ready ?? true })) };
  const leases = { run: jest.fn(async (_n: string, _t: number, fn: () => Promise<unknown>) => ({ ran: true, result: await fn() })) };
  const config = { get: (k: string) => (k === 'NGN_ACCOUNT_AUTO_OPEN' ? (o.autoOpen ?? true) : undefined) };
  const svc = new AccountOpenerService(prisma as never, accounts as never, readiness as never, leases as never, { pauseMs: 0 }, config as never);
  return { svc, prisma, accounts, readiness, leases };
}

describe('AccountOpenerService', () => {
  it('opens accounts, one customer at a time, for verified customers without one', async () => {
    const { svc, accounts, prisma } = build({ users: ['u1', 'u2'] });
    expect(await svc.run()).toEqual({ tried: 2 });
    expect(accounts.ensure.mock.calls).toEqual([['u1', 'AUTO'], ['u2', 'AUTO']]);
    const where = (prisma.user.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; take: number }])[0];
    expect(where.where).toMatchObject({ status: 'ACTIVE', kycStatus: 'APPROVED', amlStatus: 'CLEAR', kycTier: { in: ['TIER_1', 'TIER_2', 'TIER_3'] }, virtualAccounts: { none: {} } });
    expect(where.take).toBe(20);
  });

  it('skips customers who are waiting for a person or out of tries today, so they never block everyone else', async () => {
    const { svc, prisma } = build({ users: [], blocked: [{ userId: 'stuck' }, { userId: 'maxed' }] });
    await svc.run();
    const where = (prisma.user.findMany.mock.calls[0] as unknown as [{ where: { id: { notIn: string[] } } }])[0].where;
    expect(where.id).toEqual({ notIn: ['stuck', 'maxed'] });
  });

  it('does nothing while naira deposits are off or not ready', async () => {
    const { svc, prisma, accounts } = build({ users: ['u1'], ready: false });
    expect(await svc.run()).toEqual({ tried: 0 });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(accounts.ensure).not.toHaveBeenCalled();
  });

  it('NGN_ACCOUNT_AUTO_OPEN=false switches the background opener off (a GET or a tap still opens one)', async () => {
    const { svc, prisma, accounts } = build({ users: ['u1'], autoOpen: false });
    expect(await svc.run()).toEqual({ tried: 0 });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(accounts.ensure).not.toHaveBeenCalled();
  });

  it('one customer failing never stops the others', async () => {
    const { svc, accounts } = build({ users: ['u1', 'u2'] });
    accounts.ensure.mockRejectedValueOnce(new Error('boom'));
    expect(await svc.run()).toEqual({ tried: 2 });
    expect(accounts.ensure).toHaveBeenCalledTimes(2);
  });

  it('the cron runs under a lease, so one server opens accounts at a time', async () => {
    const { svc, leases } = build({ users: [] });
    await svc.cron();
    expect(leases.run).toHaveBeenCalledWith('ngn-account-opener', expect.any(Number), expect.any(Function));
  });
});
