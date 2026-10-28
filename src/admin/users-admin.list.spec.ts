import { UsersAdminService } from './users-admin.service';

describe('People → Users list: payment usernames (28 Oct 2026)', () => {
  const row = { id: 'u1', email: 'ada@x.y', firstName: 'Ada', lastName: 'Obi', phone: null, status: 'ACTIVE', kycTier: 'TIER_1', kycStatus: 'APPROVED', isTest: false, suspendedReason: null, closedEmail: null, payUsername: 'ada_4821', createdAt: new Date(), lastLoginAt: null, quidaxAccount: null };
  const build = () => {
    const prisma = { user: { findMany: jest.fn(async () => [row]), count: jest.fn(async () => 1) } };
    return { prisma, svc: new UsersAdminService(prisma as never, {} as never, {} as never, {} as never) };
  };

  it('each row shows the username', async () => {
    const { svc } = build();
    const { rows } = await svc.list({});
    expect(rows[0].payUsername).toBe('ada_4821');
  });

  it('the search finds a customer by username, with or without the @', async () => {
    for (const search of ['ada_4821', '@ada_4821']) {
      const { svc, prisma } = build();
      await svc.list({ search });
      const where = (prisma.user.findMany.mock.calls as any)[0][0].where;
      expect(where.OR).toContainEqual({ payUsername: { contains: 'ada_4821', mode: 'insensitive' } });
    }
  });
});
