import { KycTier, PolicyLevel } from '@prisma/client';
import { AddressMakerService } from './address-maker.service';

/**
 * Spec 2026-10-26 part 3: verified customers get the switched-on addresses
 * (BTC, USDT Tron, USDT BNB) without asking, a few customers a minute.
 */
const NETWORKS = [
  { assetCode: 'btc', networkId: 'btc' },
  { assetCode: 'usdt', networkId: 'trc20' },
];

function setup(o: { networks?: typeof NETWORKS; users?: Array<{ id: string; addresses: Array<{ assetCode: string; networkId: string }> }>; allowedLevels?: PolicyLevel[]; setting?: boolean; depositsOff?: boolean; failFor?: string } = {}) {
  const users = o.users ?? [{ id: 'u1', addresses: [{ assetCode: 'btc', networkId: 'btc' }] }];
  const prisma = {
    assetNetwork: { findMany: jest.fn(async () => o.networks ?? NETWORKS) },
    levelRule: { findMany: jest.fn(async () => (o.allowedLevels ?? [PolicyLevel.BASIC, PolicyLevel.ADVANCED]).map((level) => ({ level }))) },
    user: { findMany: jest.fn(async () => users) },
  };
  const addresses = {
    getOrCreate: jest.fn(async (userId: string) => {
      if (userId === o.failFor) throw new Error('Quidax is down');
      return {};
    }),
  };
  const flags = {
    assertDepositsAllowed: jest.fn(async () => {
      if (o.depositsOff) throw new Error('Crypto deposits are paused');
    }),
  };
  const settings = { get: jest.fn(() => o.setting ?? true) };
  const svc = new AddressMakerService(prisma as never, addresses as never, flags as never, { run: jest.fn() } as never, settings as never);
  return { svc, prisma, addresses };
}

describe('Addresses made in advance', () => {
  it('makes only the missing switched-on addresses, marked as made in advance', async () => {
    const t = setup();
    expect(await t.svc.run()).toEqual({ customers: 1, made: 1 });
    expect(t.addresses.getOrCreate).toHaveBeenCalledTimes(1);
    expect(t.addresses.getOrCreate).toHaveBeenCalledWith('u1', 'usdt', 'trc20', { auto: true });
  });

  it('looks only at active, approved, screened, email-confirmed customers with a Quidax sub-account, at a level allowed to deposit crypto', async () => {
    const t = setup({ allowedLevels: [PolicyLevel.ADVANCED] });
    await t.svc.run();
    const where = (t.prisma.user.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({
      status: 'ACTIVE',
      kycStatus: 'APPROVED',
      amlStatus: 'CLEAR',
      emailVerifiedAt: { not: null },
      quidaxAccount: { isNot: null },
      kycTier: { in: [KycTier.TIER_3] },
    });
  });

  it('does nothing when no network is switched on, when the setting is off, or when crypto deposits are paused', async () => {
    for (const o of [{ networks: [] }, { setting: false }, { depositsOff: true }]) {
      const t = setup(o);
      expect(await t.svc.run()).toEqual({ customers: 0, made: 0 });
      expect(t.addresses.getOrCreate).not.toHaveBeenCalled();
    }
  });

  it('nobody at a level allowed to deposit crypto: nothing to do', async () => {
    const t = setup({ allowedLevels: [PolicyLevel.NONE] });
    expect(await t.svc.run()).toEqual({ customers: 0, made: 0 });
    expect(t.prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('one customer failing does not stop the others, and is left alone for an hour', async () => {
    const users = [
      { id: 'bad', addresses: [] },
      { id: 'u2', addresses: [] },
    ];
    const t = setup({ users, failFor: 'bad' });
    expect(await t.svc.run()).toEqual({ customers: 2, made: 2 });
    await t.svc.run();
    const where = (t.prisma.user.findMany.mock.calls[1] as unknown as [{ where: { id?: { notIn: string[] } } }])[0].where;
    expect(where.id).toEqual({ notIn: ['bad'] });
  });
});
