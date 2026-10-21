import { UsersAdminService } from './users-admin.service';

function setup(status: 'ACTIVE' | 'SUSPENDED') {
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({ id: 'u1', email: 'a@b.c', firstName: 'A', lastName: 'B', status })),
      update: jest.fn(() => ({})),
    },
    refreshToken: { updateMany: jest.fn(() => ({})) },
    $transaction: jest.fn(async (ops: unknown[]) => ops),
  };
  const mail = { send: jest.fn(async () => undefined) };
  const virtualAccounts = { setDesiredForUser: jest.fn(async () => undefined) };
  const svc = new UsersAdminService(prisma as never, {} as never, mail as never, virtualAccounts as never);
  jest.spyOn(svc, 'detail').mockResolvedValue({ id: 'u1' } as never);
  return { svc, virtualAccounts };
}

describe('UsersAdminService and naira deposit accounts', () => {
  it('switches the accounts off on suspension and back on at reinstatement, so later deposits are held', async () => {
    const active = setup('ACTIVE');
    await active.svc.suspend('admin-1', 'u1', 'Fraud review');
    expect(active.virtualAccounts.setDesiredForUser).toHaveBeenCalledWith('u1', 'INACTIVE', { background: true });

    const suspended = setup('SUSPENDED');
    await suspended.svc.reinstate('admin-1', 'u1');
    expect(suspended.virtualAccounts.setDesiredForUser).toHaveBeenCalledWith('u1', 'ACTIVE', { background: true });
  });

  it('never lets the accounts fail a suspension', async () => {
    const { svc, virtualAccounts } = setup('ACTIVE');
    virtualAccounts.setDesiredForUser.mockRejectedValueOnce(new Error('boom'));
    await expect(svc.suspend('admin-1', 'u1', 'Fraud review')).resolves.toEqual({ id: 'u1' });
  });
});
