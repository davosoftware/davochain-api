import { AddressStatus } from '@prisma/client';
import { DepositAddressesAdminService, depositAddressQuery } from './deposit-addresses-admin.service';

/** Spec 2026-10-26 part 2 (admin view) and part 3 (the "Create in advance" switch). */
const NOW = new Date('2026-10-26T12:00:00Z');

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a1',
    userId: 'u1',
    assetCode: 'usdt',
    networkId: 'trc20',
    status: AddressStatus.FAILED,
    address: null,
    destinationTag: null,
    autoCreated: false,
    requestedAt: new Date('2026-10-26T10:00:00Z'),
    activatedAt: null,
    failedAt: new Date('2026-10-26T11:00:00Z'),
    network: { label: 'Tron Network' },
    user: { id: 'u1', email: 'ada@example.com', firstName: 'Ada', lastName: 'Obi' },
    ...over,
  };
}

function setup(start = row()) {
  let current = start;
  const prisma = {
    depositAddress: {
      findMany: jest.fn(async () => [current]),
      count: jest.fn(async () => 1),
      findUnique: jest.fn(async () => current),
    },
    assetNetwork: {
      findMany: jest.fn(async () => [{ assetCode: 'usdt', networkId: 'trc20', label: 'Tron Network', autoCreate: false, depositsEnabled: true, isListed: true }]),
      findUnique: jest.fn(async () => ({ assetCode: 'usdt', networkId: 'trc20', label: 'Tron Network', autoCreate: false, depositsEnabled: true, isListed: true })),
      update: jest.fn(async ({ data }: { data: { autoCreate: boolean } }) => ({ assetCode: 'usdt', networkId: 'trc20', label: 'Tron Network', autoCreate: data.autoCreate, depositsEnabled: true, isListed: true })),
    },
    adminUser: { findUnique: jest.fn(async () => ({ passwordHash: 'hash' })) },
  };
  const addresses = {
    resolve: jest.fn(async () => null),
    getOrCreate: jest.fn(async () => {
      current = { ...current, status: AddressStatus.PENDING, failedAt: null };
      return {};
    }),
  };
  const admin = { audit: jest.fn(async () => undefined) };
  const passwords = { verify: jest.fn(async (p: string) => p === 'right-password') };
  const svc = new DepositAddressesAdminService(prisma as never, addresses as never, admin as never, passwords as never);
  return { svc, prisma, addresses, admin };
}

describe('Admin: crypto addresses', () => {
  it('"stuck" means FAILED, or still waiting after 10 minutes', () => {
    const q = depositAddressQuery({ stuck: 'true' }, NOW);
    expect(q.where.OR).toEqual([
      { status: AddressStatus.FAILED },
      { status: AddressStatus.PENDING, requestedAt: { lt: new Date('2026-10-26T11:50:00Z') } },
    ]);
  });

  it('filters by coin, status and customer, and pages', () => {
    const q = depositAddressQuery({ asset: 'USDT', status: 'ACTIVE', search: 'ada', page: '3', pageSize: '10' }, NOW);
    expect(q.where).toMatchObject({ assetCode: 'usdt', status: 'ACTIVE' });
    expect(q.where.user).toEqual({ OR: expect.arrayContaining([{ email: { contains: 'ada', mode: 'insensitive' } }]) });
    expect(q).toMatchObject({ skip: 20, take: 10, page: 3, pageSize: 10 });
  });

  it('lists rows in plain shape with a stuck count', async () => {
    const t = setup();
    const r = await t.svc.list({}, NOW);
    expect(r).toMatchObject({ total: 1, stuckCount: 1, page: 1 });
    expect(r.items[0]).toMatchObject({ id: 'a1', asset: 'usdt', networkLabel: 'Tron Network', status: 'FAILED', stuck: true, customer: { email: 'ada@example.com', name: 'Ada Obi' } });
  });

  it('Try again on a FAILED address uses the customer\'s own retry, and is audited', async () => {
    const t = setup();
    const r = await t.svc.retry('admin1', 'a1', '1.2.3.4');
    expect(t.addresses.getOrCreate).toHaveBeenCalledWith('u1', 'usdt', 'trc20', { auto: false });
    expect(r.status).toBe(AddressStatus.PENDING);
    expect(t.admin.audit).toHaveBeenCalledWith('admin1', 'deposit_address.retry', 'DepositAddress', 'a1', { status: 'FAILED' }, { status: 'PENDING' }, '1.2.3.4');
  });

  it('Check again on a PENDING address only asks Quidax; it never makes a new one', async () => {
    const t = setup(row({ status: AddressStatus.PENDING, failedAt: null }));
    await t.svc.retry('admin1', 'a1');
    expect(t.addresses.resolve).toHaveBeenCalledWith('a1');
    expect(t.addresses.getOrCreate).not.toHaveBeenCalled();
  });

  it('the "Create in advance" switch needs the password and is audited', async () => {
    const t = setup();
    await expect(t.svc.setAutoCreate('admin1', 'usdt', 'trc20', true, 'wrong')).rejects.toThrow('That password is not correct.');
    expect(t.prisma.assetNetwork.update).not.toHaveBeenCalled();

    const r = await t.svc.setAutoCreate('admin1', 'usdt', 'trc20', true, 'right-password', '1.2.3.4');
    expect(r).toMatchObject({ asset: 'usdt', network: 'trc20', autoCreate: true });
    expect(t.admin.audit).toHaveBeenCalledWith('admin1', 'asset_network.auto_create', 'AssetNetwork', 'usdt/trc20', { autoCreate: false }, { autoCreate: true }, '1.2.3.4');
  });
});
