import { adminToken, balance, call, credit, hasAdmin, key, newUser, requireServer, verifyBasic, type TestUser } from './helpers';

/**
 * H11 over real HTTP: a customer's naira withdrawal is paid by the naira rail
 * (the mock Flutterwave rail), not Quidax. Needs E2E_ADMIN_* (an OWNER) to
 * switch naira payouts on for the test; they are put back to the server
 * default afterwards. Finishing a payout (settle or refund) is unit-tested.
 */
const describeAdmin = hasAdmin ? describe : describe.skip;
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';

let ADMIN: string;
let user: TestUser;
let savedId: string;
let levels: { rules: Array<Record<string, unknown>>; cooloffs: unknown[]; platform: unknown };

beforeAll(async () => {
  await requireServer();
  if (!hasAdmin) return;
  ADMIN = (await adminToken())!;
  // Local naira limits may be ₦0 (copied from the old KYC limits): lift Basic's naira withdrawal limit for this test.
  levels = (await call('GET', '/admin/levels', { token: ADMIN })).body;
  const lifted = levels.rules.map((r) => (r.level === 'BASIC' && r.action === 'NGN_WITHDRAW' ? { ...r, allowed: true, minPerTx: null, maxPerTx: null, maxPerDay: null } : r));
  expect((await call('PUT', '/admin/levels', { token: ADMIN, body: { rules: lifted, cooloffs: levels.cooloffs, platform: levels.platform } })).status).toBe(200);
  const on = await call('PUT', '/admin/withdrawals/ngn', { token: ADMIN, body: { enabled: true, password: PASSWORD, reason: 'e2e: naira payouts through the rail' } });
  expect(on.status).toBe(200);
  user = await verifyBasic(await newUser());
  credit(user, 'ngn', '20000');
  // The bank and its name come from the naira rail (mock): Access Bank 044.
  const saved = await call('POST', '/me/bank-accounts', { token: user.token, body: { bankCode: '044', accountNumber: '0123456789', password: user.password } });
  expect(saved.status).toBe(201);
  savedId = saved.body.id;
});

afterAll(async () => {
  if (hasAdmin && levels) await call('PUT', '/admin/levels', { token: ADMIN, body: { rules: levels.rules, cooloffs: levels.cooloffs, platform: levels.platform } });
  if (hasAdmin) await call('POST', '/admin/withdrawals/ngn/reset', { token: ADMIN, body: { password: PASSWORD, reason: 'e2e done', confirmInFlight: true } });
});

describeAdmin('naira withdrawals paid by the naira rail (H11)', () => {
  it('the bank list comes from the rail', async () => {
    const r = await call('GET', '/withdrawals/ngn/banks', { token: user.token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(expect.arrayContaining([{ code: '044', name: 'Access Bank' }]));
  });

  it('a withdrawal is sent through the rail and the money is locked while it goes', async () => {
    const before = await balance(user, 'ngn');
    const r = await call('POST', '/withdrawals/ngn', { token: user.token, body: { amount: '1000', savedBankAccountId: savedId }, headers: { 'Idempotency-Key': key() } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'PROCESSING', asset: 'ngn', bankName: 'Access Bank', accountNumberLast4: '6789' });
    const after = await balance(user, 'ngn');
    expect(Number(after.locked)).toBeGreaterThanOrEqual(1000);
    expect(Number(after.available)).toBeLessThan(Number(before.available));
  });
});
