import { UsersAdminService } from './users-admin.service';

/** People → Users, opened row (28 Oct 2026): the verified date of birth is shown. */
function build(kycProfile: Record<string, unknown> | null) {
  const findUnique = jest.fn(async () => ({
    id: 'u1', email: 'a@b.c', firstName: 'A', lastName: 'B', status: 'ACTIVE', createdAt: new Date(),
    quidaxAccount: null, kycProfile,
  }));
  const prisma = {
    user: { findUnique },
    balance: { findMany: jest.fn(async () => []) },
    asset: { findMany: jest.fn(async () => []) },
    transaction: { count: jest.fn(async () => 0) },
    depositAddress: { findMany: jest.fn(async () => []) },
    savedBankAccount: { findMany: jest.fn(async () => []) },
    savedCryptoAddress: { findMany: jest.fn(async () => []) },
    assetNetwork: { findMany: jest.fn(async () => []) },
  };
  const svc = new UsersAdminService(prisma as never, {} as never, {} as never, {} as never);
  return { svc, findUnique };
}

describe('UsersAdminService.detail: date of birth', () => {
  it('reads the date of birth and shows it as YYYY-MM-DD', async () => {
    const { svc, findUnique } = build({ tier: 'TIER_1', status: 'APPROVED', dateOfBirth: new Date('2000-05-01T00:00:00Z') });
    const d = await svc.detail('u1');
    expect(d.kyc).toMatchObject({ tier: 'TIER_1', dateOfBirth: '2000-05-01' });
    const select = (findUnique.mock.calls[0] as unknown as [{ include: { kycProfile: { select: Record<string, boolean> } } }])[0].include.kycProfile.select;
    expect(select.dateOfBirth).toBe(true);
    // Still never the hashes.
    expect(select).not.toHaveProperty('bvnHash');
    expect(select).not.toHaveProperty('ninHash');
  });

  it('is null before Basic verification, and with no KYC profile at all', async () => {
    expect((await build({ tier: 'TIER_0', status: 'NOT_STARTED', dateOfBirth: null }).svc.detail('u1')).kyc).toMatchObject({ dateOfBirth: null });
    expect((await build(null).svc.detail('u1')).kyc).toBeNull();
  });
});

describe('UsersAdminService: closed accounts (28 Oct 2026)', () => {
  it('the opened row shows when and why it was closed, with the original email and phone', async () => {
    const { svc, findUnique } = build({ tier: 'TIER_1', status: 'APPROVED', dateOfBirth: null });
    findUnique.mockResolvedValueOnce({
      id: 'u1', email: 'closed-u1@closed.davochain', firstName: 'A', lastName: 'B', status: 'CLOSED', createdAt: new Date(),
      quidaxAccount: null, kycProfile: null,
      closedAt: new Date('2026-10-28T10:00:00Z'), closedReason: 'Customer asked by email', closedBy: 'a1',
      closedEmail: 'ada@example.com', closedPhone: '+2348012345678',
    } as never);
    const d = await svc.detail('u1');
    expect(d).toMatchObject({
      closedAt: new Date('2026-10-28T10:00:00Z'),
      closedReason: 'Customer asked by email',
      closedEmail: 'ada@example.com',
      closedPhone: '+2348012345678',
    });
  });

  it('searching by the original email or phone still finds a closed account', async () => {
    const findMany = jest.fn(async () => []);
    const prisma = { user: { findMany, count: jest.fn(async () => 0), groupBy: jest.fn(async () => []) }, balance: { groupBy: jest.fn(async () => []) } };
    const svc = new UsersAdminService(prisma as never, {} as never, {} as never, {} as never);
    await svc.list({ search: 'ada@example.com' } as never).catch(() => undefined);
    const where = JSON.stringify((findMany.mock.calls[0] as unknown as [{ where: unknown }] | undefined)?.[0]?.where ?? {});
    expect(where).toContain('closedEmail');
    expect(where).toContain('closedPhone');
  });
});
