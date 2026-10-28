import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { AccountClosureService } from './account-closure.service';

/**
 * People → Users → Close account (28 Oct 2026). Owners only, with password and
 * reason. Refused while the customer holds money or has anything in progress.
 * The records stay; the email and phone are released so the person can sign up
 * again.
 */
function build(opts: {
  status?: string;
  balances?: Array<{ assetCode: string; available: string; locked: string }>;
  inFlight?: number;
  giftCards?: number;
  passwordOk?: boolean;
} = {}) {
  const user = {
    id: 'u1', email: 'ada@example.com', phone: '+2348012345678', firstName: 'Ada', lastName: 'Obi',
    status: opts.status ?? 'ACTIVE',
  };
  const prisma: Record<string, any> = {
    user: {
      findUnique: jest.fn(async () => user),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(user, data)),
    },
    balance: { findMany: jest.fn(async () => opts.balances ?? []) },
    transaction: { count: jest.fn(async () => opts.inFlight ?? 0) },
    giftCardTrade: { count: jest.fn(async () => opts.giftCards ?? 0) },
    refreshToken: { updateMany: jest.fn(async () => ({ count: 2 })) },
    adminUser: {
      findUnique: jest.fn(async () => ({ passwordHash: 'hash' })),
      findMany: jest.fn(async () => [{ email: 'owner1@davochain.com' }, { email: 'owner2@davochain.com' }]),
    },
    adminAuditLog: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(prisma as unknown)),
  };
  const passwords = { verify: jest.fn(async () => opts.passwordOk ?? true) };
  const mail = { send: jest.fn(async () => true) };
  const templated = { send: jest.fn(async () => undefined) };
  const virtualAccounts = { setDesiredForUser: jest.fn(async () => undefined) };
  const svc = new AccountClosureService(prisma as never, passwords as never, mail as never, templated as never, virtualAccounts as never);
  return { svc, prisma, user, mail, templated, virtualAccounts };
}

const owner = { id: 'a1', role: 'OWNER', ip: '1.2.3.4' };
const good = { password: 'right', reason: 'Customer asked us to close it by email' };

describe('AccountClosureService.check', () => {
  it('an empty account with nothing in progress can be closed', async () => {
    const { svc } = build({ balances: [{ assetCode: 'ngn', available: '0', locked: '0' }] });
    expect(await svc.check('u1')).toEqual({ canClose: true, blockers: [] });
  });

  it('lists every coin still held, and anything in progress', async () => {
    const { svc } = build({
      balances: [
        { assetCode: 'ngn', available: '12500.5', locked: '0' },
        { assetCode: 'btc', available: '0', locked: '0.002' },
        { assetCode: 'usdt', available: '0', locked: '0' },
      ],
      inFlight: 1,
      giftCards: 2,
    });
    const r = await svc.check('u1');
    expect(r.canClose).toBe(false);
    expect(r.blockers.map((b) => b.code)).toEqual(['BALANCE', 'BALANCE', 'TRANSACTIONS', 'GIFT_CARDS']);
    expect(r.blockers[0]).toMatchObject({ asset: 'ngn', amount: '12500.5', message: 'Holds 12500.5 NGN' });
    expect(r.blockers[1]).toMatchObject({ asset: 'btc', amount: '0.002' });
    expect(r.blockers[2].message).toBe('1 transaction still in progress');
    expect(r.blockers[3].message).toBe('2 gift card sales waiting for a decision');
  });

  it('an account already closed says so', async () => {
    const { svc } = build({ status: 'CLOSED' });
    expect((await svc.check('u1')).blockers).toEqual([{ code: 'ALREADY_CLOSED', message: 'This account is already closed' }]);
  });
});

describe('AccountClosureService.close', () => {
  it('only an owner, with a reason of 10+ characters and the right password', async () => {
    await expect(build().svc.close({ ...owner, role: 'SUB_ADMIN' }, 'u1', good)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(build().svc.close(owner, 'u1', { ...good, reason: 'too short' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(build({ passwordOk: false }).svc.close(owner, 'u1', good)).rejects.toThrow('That password is not correct.');
  });

  it('refuses while money is held or anything is in progress, and changes nothing', async () => {
    const h = build({ balances: [{ assetCode: 'ngn', available: '1', locked: '0' }] });
    const err = await h.svc.close(owner, 'u1', good).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'ACCOUNT_NOT_EMPTY', blockers: [expect.objectContaining({ code: 'BALANCE' })] });
    expect(h.prisma.user.update).not.toHaveBeenCalled();
    expect(h.prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('closes: signed out, naira account off, email and phone released, originals kept, audited, everyone told', async () => {
    const h = build();
    const r = await h.svc.close(owner, 'u1', good);
    expect(r).toMatchObject({ closed: true });

    const data = (h.prisma.user.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({
      status: 'CLOSED',
      closedReason: 'Customer asked us to close it by email',
      closedBy: 'a1',
      closedEmail: 'ada@example.com',
      closedPhone: '+2348012345678',
      phone: null,
      email: 'closed-u1@closed.davochain',
    });
    expect(data.closedAt).toBeInstanceOf(Date);

    expect(h.prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { userId: 'u1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(h.virtualAccounts.setDesiredForUser).toHaveBeenCalledWith('u1', 'INACTIVE', { background: true });
    expect(h.prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ adminUserId: 'a1', action: 'user.close', entity: 'User', entityId: 'u1', ip: '1.2.3.4' }),
    });
    // The customer hears at their real address, before it was released.
    expect(h.templated.send).toHaveBeenCalledWith(expect.objectContaining({ key: 'user.closed', to: 'ada@example.com' }));
    // Every owner is emailed.
    expect(h.mail.send.mock.calls.map((c) => (c as unknown as [{ to: string }])[0].to)).toEqual(['owner1@davochain.com', 'owner2@davochain.com']);
  });

  it('an account with no phone still closes', async () => {
    const h = build();
    h.user.phone = null as never;
    await h.svc.close(owner, 'u1', good);
    expect((h.prisma.user.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data).toMatchObject({ closedPhone: null, phone: null });
  });

  it('closing an account that is already closed is refused', async () => {
    await expect(build({ status: 'CLOSED' }).svc.close(owner, 'u1', good)).rejects.toBeInstanceOf(ConflictException);
  });

  it('a failed email never undoes the closing', async () => {
    const h = build();
    h.templated.send.mockRejectedValueOnce(new Error('SMTP down'));
    await expect(h.svc.close(owner, 'u1', good)).resolves.toMatchObject({ closed: true });
  });
});
