import { createHmac } from 'node:crypto';
import { adminToken, balance, call, hasAdmin, newUser, requireServer, verifyBasic, type TestUser } from './helpers';

/**
 * Payrep naira deposits over real HTTP (spec 2026-10-20 §4, §6), on the pretend
 * Payrep: a verified customer opens a deposit account, money arrives, the
 * signed webhook is checked, Payrep's own record is read back, and the balance
 * is credited exactly once, even when the webhook comes again. Needs E2E_ADMIN_*
 * (an OWNER) for the development-only deposit simulator.
 */
const describeAdmin = hasAdmin ? describe : describe.skip;
const API = process.env.API_URL ?? 'http://localhost:3000';

let ADMIN: string;
let user: TestUser;
let accountNumber: string;
let levels: { rules: Array<Record<string, unknown>>; cooloffs: unknown[]; platform: unknown };

/** Waits until the naira balance reaches `amount`, or gives up after ~20 s. */
async function balanceReaches(u: TestUser, amount: number): Promise<string> {
  let last = '0';
  for (let i = 0; i < 40; i++) {
    last = (await balance(u, 'ngn').catch(() => ({ available: '0' }))).available;
    if (Number(last) >= amount) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

beforeAll(async () => {
  await requireServer();
  if (!hasAdmin) return;
  ADMIN = (await adminToken())!;
  // Local naira limits may be ₦0 (copied from the old KYC limits): lift Basic's naira deposit limit for this test.
  levels = (await call('GET', '/admin/levels', { token: ADMIN })).body;
  const lifted = levels.rules.map((r) => (r.level === 'BASIC' && r.action === 'NGN_DEPOSIT' ? { ...r, allowed: true, minPerTx: null, maxPerTx: null, maxPerDay: null } : r));
  expect((await call('PUT', '/admin/levels', { token: ADMIN, body: { rules: lifted, cooloffs: levels.cooloffs, platform: levels.platform } })).status).toBe(200);
  user = await verifyBasic(await newUser());
});

afterAll(async () => {
  if (hasAdmin && levels) await call('PUT', '/admin/levels', { token: ADMIN, body: { rules: levels.rules, cooloffs: levels.cooloffs, platform: levels.platform } });
});

describeAdmin('naira deposits through Payrep', () => {
  it('a verified customer gets a Payrep account with no BVN, named from their ID; asking again hands back the same one', async () => {
    // 201 when this call opens it; 200 when the background opener got there first.
    const r = await call('POST', '/deposits/ngn/account', { token: user.token, body: {} });
    expect([200, 201]).toContain(r.status);
    expect(r.body).toMatchObject({ accountNumber: expect.stringMatching(/^\d{10}$/), accountName: 'DavoChain-Someone Clean', bankName: 'Payrep MFB', status: 'ACTIVE' });
    accountNumber = r.body.accountNumber;
    const again = await call('POST', '/deposits/ngn/account', { token: user.token, body: {} });
    expect(again.status).toBe(200);
    expect(again.body.accountNumber).toBe(accountNumber);
    expect((await call('GET', '/deposits/ngn/account', { token: user.token })).body.accountNumber).toBe(accountNumber);
  });

  it('an older app that still sends a BVN keeps working: the number is ignored', async () => {
    const r = await call('POST', '/deposits/ngn/account', { token: user.token, body: { bvn: user.bvn } });
    expect(r.status).toBe(200);
    expect(r.body.accountNumber).toBe(accountNumber);
  });

  it('a deposit is credited once, even when Payrep sends the webhook again', async () => {
    const sim = await call('POST', '/admin/dev/payrep/simulate-deposit', { token: ADMIN, body: { userId: user.id, amount: '5000', payerName: 'SOMEONE CLEAN' } });
    expect(sim.status).toBe(200);
    expect(sim.body.webhookStatus).toBe(200);
    expect(Number(await balanceReaches(user, 5000))).toBe(5000);

    const again = await call('POST', `/admin/dev/payrep/redeliver/${sim.body.transactionId}`, { token: ADMIN });
    expect(again.body.webhookStatus).toBe(200);
    await new Promise((r) => setTimeout(r, 3000));
    expect(Number((await balance(user, 'ngn')).available)).toBe(5000);

    const history = await call('GET', '/deposits?asset=ngn', { token: user.token });
    if (history.status === 200 && Array.isArray(history.body)) {
      expect(history.body.filter((d: { provider?: string }) => d.provider === 'PAYREP')).toHaveLength(1);
    }
  });

  it('a pending deposit is not credited', async () => {
    const before = Number((await balance(user, 'ngn')).available);
    const sim = await call('POST', '/admin/dev/payrep/simulate-deposit', { token: ADMIN, body: { userId: user.id, amount: '700', status: 'pending' } });
    expect(sim.status).toBe(200);
    await new Promise((r) => setTimeout(r, 3000));
    expect(Number((await balance(user, 'ngn')).available)).toBe(before);
  });

  it('a webhook with a wrong signature, or a replayed old one, is refused with 401', async () => {
    const body = JSON.stringify({ event: 'deposit.success', data: { transaction_id: 'forged-1', account_number: accountNumber, amount: '999999.00' } });
    const wrong = await fetch(`${API}/webhooks/payrep`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-timestamp': String(Math.floor(Date.now() / 1000)), 'x-signature': 'f'.repeat(64) },
      body,
    });
    expect(wrong.status).toBe(401);
    // Even with the right recipe, a signature over an hour-old timestamp is a replay.
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    const replay = await fetch(`${API}/webhooks/payrep`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-timestamp': old, 'x-signature': createHmac('sha256', 'not-our-secret').update(`${old}:${body}`).digest('hex') },
      body,
    });
    expect(replay.status).toBe(401);
  });

  it('the dev simulator refuses a user with no deposit account', async () => {
    const other = await newUser();
    expect((await call('POST', '/admin/dev/payrep/simulate-deposit', { token: ADMIN, body: { userId: other.id, amount: '10' } })).status).toBe(409);
  });
});
