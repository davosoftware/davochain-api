import { PayUsernamesService } from './pay-usernames.service';

/** Choosing, changing and finding payment usernames (28 Oct 2026). */
const DAY = 24 * 60 * 60 * 1000;

function build(opts: {
  me?: Record<string, unknown>;
  owner?: Record<string, unknown> | null;
  hold?: { userId: string; heldUntil: Date } | null;
} = {}) {
  const me = { id: 'alice', payUsername: null, payUsernameSetAt: null, ...opts.me };
  const tx = {
    user: { update: jest.fn() },
    payUsernameHold: { upsert: jest.fn(), deleteMany: jest.fn() },
  };
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => (where.id ? me : opts.owner ?? null)),
    },
    payUsernameHold: { findUnique: jest.fn(async () => opts.hold ?? null) },
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  return { service: new PayUsernamesService(prisma as never), prisma, tx };
}

describe('PayUsernamesService.set', () => {
  it('saves a free, valid name in lower case', async () => {
    const { service, tx } = build();
    await expect(service.set('alice', 'Ada_Okafor')).resolves.toMatchObject({ payUsername: 'ada_okafor' });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'alice' }, data: { payUsername: 'ada_okafor', payUsernameSetAt: expect.any(Date) } });
  });

  it('refuses a name that breaks the rules, with the reason', async () => {
    const err = await build().service.set('alice', 'ada').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'USERNAME_INVALID', message: expect.stringMatching(/at least 7/) });
  });

  it("refuses someone else's name", async () => {
    const err = await build({ owner: { id: 'bob' } }).service.set('alice', 'ada_okafor').catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: 'USERNAME_TAKEN' });
  });

  it('refuses a name another person gave up less than 30 days ago', async () => {
    const err = await build({ hold: { userId: 'bob', heldUntil: new Date(Date.now() + DAY) } }).service.set('alice', 'ada_okafor').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'USERNAME_TAKEN' });
  });

  it('your own held name can be taken back', async () => {
    const { service, tx } = build({ hold: { userId: 'alice', heldUntil: new Date(Date.now() + DAY) } });
    await service.set('alice', 'ada_okafor');
    expect(tx.payUsernameHold.deleteMany).toHaveBeenCalledWith({ where: { username: 'ada_okafor' } });
  });

  it('changing keeps the old name from everyone else for 30 days', async () => {
    const { service, tx } = build({ me: { payUsername: 'old_name', payUsernameSetAt: new Date(Date.now() - 40 * DAY) } });
    await service.set('alice', 'new_name1');
    const hold = tx.payUsernameHold.upsert.mock.calls[0][0];
    expect(hold.where).toEqual({ username: 'old_name' });
    expect(hold.create.heldUntil.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
  });

  it('can be changed only once every 30 days', async () => {
    const err = await build({ me: { payUsername: 'old_name', payUsernameSetAt: new Date(Date.now() - 5 * DAY) } }).service.set('alice', 'new_name1').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'USERNAME_CHANGE_TOO_SOON', until: expect.any(String) });
  });

  it('setting the same name again changes nothing', async () => {
    const { service, tx } = build({ me: { payUsername: 'ada_okafor', payUsernameSetAt: new Date() } });
    await expect(service.set('alice', 'ADA_OKAFOR')).resolves.toMatchObject({ payUsername: 'ada_okafor' });
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});

describe('PayUsernamesService.lookup: who am I sending to?', () => {
  const bob = { id: 'bob', firstName: 'Bob', lastName: 'Eze', status: 'ACTIVE', kycTier: 'TIER_1', payUsername: 'bob_eze_1' };

  it('gives the short name and whether they can receive', async () => {
    await expect(build({ owner: bob }).service.lookup('alice', '@Bob_Eze_1')).resolves.toEqual({ username: 'bob_eze_1', displayName: 'Bob E.', canReceive: true, reason: null });
  });

  it('an unverified person shows, but cannot receive yet', async () => {
    const r = await build({ owner: { ...bob, kycTier: 'TIER_0' } }).service.lookup('alice', 'bob_eze_1');
    expect(r).toMatchObject({ canReceive: false, reason: expect.stringMatching(/Basic verification/) });
  });

  it('a closed account is "not found", like a name nobody has', async () => {
    const err = await build({ owner: { ...bob, status: 'CLOSED' } }).service.lookup('alice', 'bob_eze_1').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'USERNAME_NOT_FOUND' });
  });

  it('an unknown name is 404 USERNAME_NOT_FOUND', async () => {
    const err = await build({ owner: null }).service.lookup('alice', 'nobody_here').catch((e) => e);
    expect(err.getStatus()).toBe(404);
  });

  it('yourself cannot receive from yourself', async () => {
    const r = await build({ owner: { ...bob, id: 'alice' } }).service.lookup('alice', 'bob_eze_1');
    expect(r).toMatchObject({ canReceive: false, reason: 'This is your own username.' });
  });
});

describe('PayUsernamesService.removeByAdmin: an offensive name taken away', () => {
  it('clears it, holds it for 30 days and tells the customer why', async () => {
    const { prisma, tx } = build({ me: { payUsername: 'rude_name1', payUsernameSetAt: new Date() } });
    const notifications = { notify: jest.fn() };
    const service = new PayUsernamesService(prisma as never, notifications as never);
    await expect(service.removeByAdmin('alice', 'Offensive to other customers')).resolves.toEqual({ before: 'rude_name1' });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'alice' }, data: { payUsername: null, payUsernameSetAt: null } });
    expect(tx.payUsernameHold.upsert.mock.calls[0][0].where).toEqual({ username: 'rude_name1' });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'alice', body: expect.stringContaining('Offensive to other customers') }));
  });

  it('a customer without a name: 404', async () => {
    const err = await build().service.removeByAdmin('alice', 'Offensive to other customers').catch((e) => e);
    expect(err.getStatus()).toBe(404);
  });
});
