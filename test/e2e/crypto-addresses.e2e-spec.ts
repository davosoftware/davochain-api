import { adminToken, call, hasAdmin, newUser, requireServer, verifyBasic, type TestUser } from './helpers';

/**
 * Crypto addresses (spec 2026-10-26), over real HTTP on the pretend Quidax:
 * the addresses switched on are made in advance after Basic, the customer's own
 * request returns them at once, and admins see them and the switch. (Stuck and
 * failed addresses are covered by the unit tests: the pretend Quidax always
 * delivers.) The maker runs once a minute, so this spec waits up to ~2 minutes.
 */
jest.setTimeout(240_000);

const describeAdmin = hasAdmin ? describe : describe.skip;
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const MADE_IN_ADVANCE = ['btc/btc', 'usdt/bep20', 'usdt/trc20'];

let ADMIN: string;
let user: TestUser;

const pairs = (rows: Array<{ asset: string; network: string; status: string }>) =>
  rows.filter((r) => r.status === 'ACTIVE').map((r) => `${r.asset}/${r.network}`).sort();

beforeAll(async () => {
  await requireServer();
  if (hasAdmin) ADMIN = (await adminToken())!;
  user = await verifyBasic(await newUser('Address', 'Tester'));
});

describe('Addresses made in advance', () => {
  it('a newly verified customer gets BTC, USDT (Tron) and USDT (BNB) without asking', async () => {
    let have: string[] = [];
    for (let i = 0; i < 50 && MADE_IN_ADVANCE.some((p) => !have.includes(p)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const r = await call('GET', '/deposits/addresses', { token: user.token });
      expect(r.status).toBe(200);
      have = pairs(r.body);
    }
    expect(have).toEqual(expect.arrayContaining(MADE_IN_ADVANCE));
  });

  it('opening Receive for one of them answers at once with the same address', async () => {
    const list = await call('GET', '/deposits/addresses', { token: user.token });
    const before = list.body.find((a: { asset: string; network: string }) => a.asset === 'usdt' && a.network === 'trc20');
    const r = await call('POST', '/deposits/address', { token: user.token, body: { asset: 'usdt', network: 'trc20' } });
    expect([200, 201]).toContain(r.status);
    expect(r.body).toMatchObject({ status: 'ACTIVE', usable: true, address: before.address });
  });
});

describeAdmin('Admin: crypto addresses', () => {
  it('lists the customer\'s addresses, marked as made in advance', async () => {
    const r = await call('GET', `/admin/deposit-addresses?search=${encodeURIComponent(user.email)}`, { token: ADMIN });
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThanOrEqual(3);
    expect(r.body.items[0]).toMatchObject({ customer: { email: user.email }, autoCreated: true, stuck: false });
    expect(typeof r.body.stuckCount).toBe('number');
  });

  it('the user details include their deposit addresses', async () => {
    const r = await call('GET', `/admin/users/${user.id}`, { token: ADMIN });
    expect(r.status).toBe(200);
    expect(r.body.depositAddresses.map((a: { asset: string; network: string }) => `${a.asset}/${a.network}`)).toEqual(expect.arrayContaining(MADE_IN_ADVANCE));
  });

  it('a ready address has nothing to try again', async () => {
    const list = await call('GET', `/admin/deposit-addresses?search=${encodeURIComponent(user.email)}&status=ACTIVE`, { token: ADMIN });
    const r = await call('POST', `/admin/deposit-addresses/${list.body.items[0].id}/retry`, { token: ADMIN });
    expect(r.status).toBe(400);
  });

  it('shows which networks are made in advance; changing one needs the password', async () => {
    const nets = await call('GET', '/admin/asset-networks', { token: ADMIN });
    expect(nets.status).toBe(200);
    expect(nets.body).toEqual(expect.arrayContaining([expect.objectContaining({ asset: 'btc', network: 'btc', autoCreate: true })]));

    const wrong = await call('PUT', '/admin/asset-networks/btc/btc/auto-create', { token: ADMIN, body: { enabled: false, password: 'Not-the-password-1' } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toBe('That password is not correct.');

    // Off and back on, so the next run starts as it was.
    const off = await call('PUT', '/admin/asset-networks/btc/btc/auto-create', { token: ADMIN, body: { enabled: false, password: PASSWORD } });
    expect(off.body).toMatchObject({ asset: 'btc', autoCreate: false });
    const on = await call('PUT', '/admin/asset-networks/btc/btc/auto-create', { token: ADMIN, body: { enabled: true, password: PASSWORD } });
    expect(on.body).toMatchObject({ asset: 'btc', autoCreate: true });
  });
});
