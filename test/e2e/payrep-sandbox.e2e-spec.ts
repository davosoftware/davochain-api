import { adminToken, balance, call, credit, hasAdmin, key, newUser, requireServer, verifyBasic, type TestUser } from './helpers';

/**
 * Naira on Payrep's REAL SANDBOX, over real HTTP (no money moves: it is the test system).
 *
 * Runs only when asked: PAYREP_SANDBOX_E2E=yes, against a server started with
 *   npm run start:e2e -- 3001 --payrep-sandbox
 * Needs E2E_ADMIN_* (an OWNER). It opens a real sandbox customer account, sends
 * small real sandbox transfers (₦100 payout, ₦100 Treasury move) and checks them.
 * Incoming deposits can't be made from the API on the sandbox; they are tested
 * with a deposit sent from the Payrep dashboard.
 */
const run = process.env.PAYREP_SANDBOX_E2E === 'yes' && hasAdmin;
const describeSandbox = run ? describe : describe.skip;
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const BANK = { code: '044', accountNumber: '0123456789' }; // Access Bank as the sandbox lists it

let ADMIN: string;
let user: TestUser;
let savedId: string;
let levels: { rules: Array<Record<string, unknown>>; cooloffs: unknown[]; platform: unknown };

beforeAll(async () => {
  if (!run) return;
  await requireServer();
  ADMIN = (await adminToken())!;
  levels = (await call('GET', '/admin/levels', { token: ADMIN })).body;
  const lifted = levels.rules.map((r) =>
    r.level === 'BASIC' && (r.action === 'NGN_DEPOSIT' || r.action === 'NGN_WITHDRAW') ? { ...r, allowed: true, minPerTx: null, maxPerTx: null, maxPerDay: null } : r,
  );
  expect((await call('PUT', '/admin/levels', { token: ADMIN, body: { rules: lifted, cooloffs: levels.cooloffs, platform: levels.platform } })).status).toBe(200);
  expect((await call('PUT', '/admin/withdrawals/ngn', { token: ADMIN, body: { enabled: true, password: PASSWORD, reason: 'sandbox e2e: naira payouts' } })).status).toBe(200);
  user = await verifyBasic(await newUser());
}, 60_000);

afterAll(async () => {
  if (!run) return;
  if (levels) await call('PUT', '/admin/levels', { token: ADMIN, body: { rules: levels.rules, cooloffs: levels.cooloffs, platform: levels.platform } });
  await call('POST', '/admin/withdrawals/ngn/reset', { token: ADMIN, body: { password: PASSWORD, reason: 'sandbox e2e done', confirmInFlight: true } });
});

describeSandbox('naira on the real Payrep sandbox', () => {
  it('readiness: the real sandbox answers our keys, and every required check is green', async () => {
    const r = await call('GET', '/admin/naira-rail/readiness?refresh=true', { token: ADMIN });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('TEST');
    const red = r.body.checks.filter((c: { required: boolean; ok: boolean }) => c.required && !c.ok).map((c: { key: string; detail: string }) => `${c.key}: ${c.detail}`);
    expect(red).toEqual([]);
    expect(r.body.canCreateAccounts).toBe(true);
  });

  it('a verified customer opens a real Payrep sandbox account', async () => {
    const r = await call('POST', '/deposits/ngn/account', { token: user.token, body: { bvn: user.bvn } });
    expect(r.status).toBe(201);
    expect(r.body.accountNumber).toMatch(/^\d{10}$/);
    expect(r.body.status).toBe('ACTIVE');
    expect(typeof r.body.bankName).toBe('string');
    const again = await call('POST', '/deposits/ngn/account', { token: user.token, body: { bvn: user.bvn } });
    expect(again.status).toBe(200);
    expect(again.body.accountNumber).toBe(r.body.accountNumber);
  });

  it('the bank list and the account-name check come from Payrep', async () => {
    const banks = await call('GET', '/withdrawals/ngn/banks', { token: user.token });
    expect(banks.status).toBe(200);
    expect(banks.body).toEqual(expect.arrayContaining([{ code: BANK.code, name: 'Access Bank' }]));
    const saved = await call('POST', '/me/bank-accounts', { token: user.token, body: { bankCode: BANK.code, accountNumber: BANK.accountNumber, password: user.password } });
    expect(saved.status).toBe(201);
    expect(saved.body.accountName.length).toBeGreaterThan(0);
    savedId = saved.body.id;
  });

  it('a ₦100 payout is sent through Payrep once and the money is locked while it goes', async () => {
    credit(user, 'ngn', '5000');
    const r = await call('POST', '/withdrawals/ngn', { token: user.token, body: { amount: '100', savedBankAccountId: savedId }, headers: { 'Idempotency-Key': key() } });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('PROCESSING');
    const b = await balance(user, 'ngn');
    expect(Number(b.locked)).toBeGreaterThanOrEqual(100);
  });

  // On the sandbox an inter-bank transfer is listed "pending" (an internal one settles at once), so the
  // move reads as still sending or arrived: never failed, never refunded.
  it('a ₦100 Treasury move is sent, and "check with the bank now" reads Payrep\'s list: sending or arrived, never failed', async () => {
    const settings = await call('PUT', '/admin/treasury/settings', {
      token: ADMIN,
      body: { payoutReserveNgn: 0, fundingBankCode: BANK.code, fundingAccountNumber: BANK.accountNumber, password: PASSWORD },
    });
    expect(settings.status).toBe(200);
    const sent = await call('POST', '/admin/treasury/moves', { token: ADMIN, body: { amount: 100, password: PASSWORD } });
    let moveId: string;
    if (sent.status === 409) {
      // An earlier run's move is still pending at Payrep: only one at a time. Check that one instead.
      const before = await call('GET', '/admin/treasury', { token: ADMIN });
      moveId = before.body.moves.find((m: { status: string }) => m.status === 'SENDING').id;
    } else {
      expect(sent.status).toBe(201);
      expect(sent.body.status).toBe('SENDING');
      moveId = sent.body.moveId;
    }
    const checked = await call('POST', `/admin/treasury/moves/${moveId}/check`, { token: ADMIN });
    expect(checked.status).toBe(200);
    const after = await call('GET', '/admin/treasury', { token: ADMIN });
    const move = after.body.moves.find((m: { id: string }) => m.id === moveId);
    expect(['SENDING', 'ARRIVED']).toContain(move.status);
    console.log(`Treasury move after "check now": ${move.status}`);
  });
});
