import { ServiceUnavailableException } from '@nestjs/common';
import { ProvisioningService } from './provisioning.service';
import { QuidaxError } from '../quidax/quidax.errors';

/**
 * OPEN_ISSUES A3: a customer's Quidax sub-account is created by the sign-up
 * job AND on demand (first "Receive"). Quidax sub-accounts can never be
 * deleted, so the two must never both create one.
 */
function setup(opts: { leaseHeldElsewhere?: boolean; appearsAfter?: number; createError?: Error } = {}) {
  let row: { quidaxUserId: string } | null = null;
  let reads = 0;
  const prisma = {
    quidaxAccount: {
      findUnique: jest.fn(async () => {
        reads++;
        if (!row && opts.appearsAfter !== undefined && reads > opts.appearsAfter) row = { quidaxUserId: 'q-other' };
        return row;
      }),
      create: jest.fn(async ({ data }: { data: { quidaxUserId: string } }) => (row = { quidaxUserId: data.quidaxUserId })),
    },
    user: { findUniqueOrThrow: jest.fn(async () => ({ id: 'u1', firstName: 'Ada', lastName: 'Obi', isTest: true })) },
  };
  const quidax = {
    createSubAccount: jest.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      if (opts.createError) throw opts.createError;
      return { id: 'q1', sn: 'SN1' };
    }),
  };
  // A lease like JobLeaseService: one holder at a time, by name.
  const held = new Set<string>(opts.leaseHeldElsewhere ? ['provision-u1'] : []);
  const leases = {
    run: jest.fn(async (name: string, _ttl: number, fn: () => Promise<unknown>) => {
      if (held.has(name)) return { ran: false };
      held.add(name);
      try {
        return { ran: true, result: await fn() };
      } finally {
        held.delete(name);
      }
    }),
  };
  const alerts = { raise: jest.fn(async () => true) };
  const config = { getOrThrow: (k: string) => (k === 'TEST_ALIAS_EMAIL_DOMAIN' ? 'test.davochain.com' : 'users.davochain.com') };
  const svc = new ProvisioningService(prisma as never, quidax as never, config as never, { add: jest.fn() } as never, leases as never, alerts as never);
  (svc as unknown as { waitMs: number }).waitMs = 5;
  return { svc, quidax, alerts };
}

describe('Provisioning a Quidax sub-account: never two for one customer', () => {
  it('two at once (sign-up job and first Receive): Quidax is asked once, both get the same account', async () => {
    const { svc, quidax } = setup();
    const [a, b] = await Promise.all([svc.provision('u1'), svc.provision('u1')]);
    expect(quidax.createSubAccount).toHaveBeenCalledTimes(1);
    expect(a.quidaxUserId).toBe('q1');
    expect(b.quidaxUserId).toBe('q1');
  });

  it('another server is creating it: wait for its result, never create a second', async () => {
    const { svc, quidax } = setup({ leaseHeldElsewhere: true, appearsAfter: 3 });
    await expect(svc.provision('u1')).resolves.toEqual({ quidaxUserId: 'q-other', created: false });
    expect(quidax.createSubAccount).not.toHaveBeenCalled();
  });

  it('another server is creating it and it does not appear in time: "try again", still nothing created', async () => {
    const { svc, quidax } = setup({ leaseHeldElsewhere: true });
    await expect(svc.provision('u1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(quidax.createSubAccount).not.toHaveBeenCalled();
  });

  it('Quidax says the alias already exists (an earlier answer was lost): owners are told which, to link it by hand', async () => {
    const { svc, alerts } = setup({ createError: new QuidaxError('Email has already been taken', null, 422) });
    await expect(svc.provision('u1')).rejects.toBeInstanceOf(QuidaxError);
    expect(alerts.raise).toHaveBeenCalledWith(
      'RECONCILIATION_DRIFT',
      'quidax-account:u1',
      expect.stringMatching(/already exists/),
      expect.arrayContaining([expect.stringContaining('t_u1@test.davochain.com')]),
    );
  });
});
