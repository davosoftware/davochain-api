import { adminToken, call, hasAdmin, requireServer } from './helpers';

/**
 * Treasury over real HTTP, with the mock naira rail (₦50,000,000 balance;
 * transfers succeed on the first status check). Needs E2E_ADMIN_* (an OWNER).
 * The settings it changes are put back.
 */
const describeAdmin = hasAdmin ? describe : describe.skip;
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';

let ADMIN: string;
let before: { reserve: string; fundingAccount: unknown };

beforeAll(async () => {
  await requireServer();
  if (!hasAdmin) return;
  ADMIN = (await adminToken())!;
  const r = await call('GET', '/admin/treasury', { token: ADMIN });
  before = r.body;
});

afterAll(async () => {
  if (hasAdmin && before) {
    await call('PUT', '/admin/treasury/settings', { token: ADMIN, body: { payoutReserveNgn: Math.trunc(Number(before.reserve)), password: PASSWORD } });
  }
});

describeAdmin('Treasury', () => {
  it('shows what we hold against what customers are owed', async () => {
    const r = await call('GET', '/admin/treasury', { token: ADMIN });
    expect(r.status).toBe(200);
    expect(['YES', 'SHORT', 'UNKNOWN']).toContain(r.body.covered);
    expect(r.body.rail).toMatchObject({ name: 'Payrep' });
    expect(r.body.rail.available).toBe('50000000');
  });

  it('a wrong password changes nothing', async () => {
    const r = await call('PUT', '/admin/treasury/settings', { token: ADMIN, body: { payoutReserveNgn: 1, password: 'Not-the-password-1' } });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('That password is not correct.');
  });

  it('an owner sets the reserve and the funding account (name from the bank)', async () => {
    const name = await call('POST', '/admin/treasury/check-name', { token: ADMIN, body: { bankCode: '000014', accountNumber: '0123456789' } });
    expect(name.status).toBe(200);
    expect(name.body).toMatchObject({ bankName: 'Access Bank', accountName: 'MOCK ACCOUNT 6789' });

    const r = await call('PUT', '/admin/treasury/settings', {
      token: ADMIN,
      body: { payoutReserveNgn: 1000000, fundingBankCode: '000014', fundingAccountNumber: '0123456789', password: PASSWORD },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ reserve: '1000000', fundingAccount: { bankCode: '000014', bankName: 'Access Bank', accountNumberMasked: '******6789', accountName: 'MOCK ACCOUNT 6789' } });
  });

  it('never more than is available to move', async () => {
    const r = await call('POST', '/admin/treasury/moves', { token: ADMIN, body: { amount: 60000000, password: PASSWORD } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/^You can move up to ₦/);
  });

  it('an owner sends ₦1,000 to Quidax; asking the bank finishes it as arrived', async () => {
    const sent = await call('POST', '/admin/treasury/moves', { token: ADMIN, body: { amount: 1000, password: PASSWORD } });
    expect(sent.status).toBe(201);
    expect(sent.body.status).toBe('SENDING');

    const again = await call('POST', '/admin/treasury/moves', { token: ADMIN, body: { amount: 1000, password: PASSWORD } });
    expect(again.status).toBe(409);

    const checked = await call('POST', `/admin/treasury/moves/${sent.body.moveId}/check`, { token: ADMIN });
    expect(checked.status).toBe(200);
    const after = await call('GET', '/admin/treasury', { token: ADMIN });
    expect(after.body.moves.find((m: { id: string }) => m.id === sent.body.moveId)).toMatchObject({ status: 'ARRIVED' });
  });
});
