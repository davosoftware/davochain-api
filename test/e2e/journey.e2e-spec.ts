import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ADDRESS, adminToken, balance, call, hasAdmin, idNumber, key, login, requireServer, uniquePhone, type TestUser } from './helpers';

/**
 * The whole customer journey over real HTTP, in order (launch request, 22 Oct 2026):
 * sign up → confirm email → Basic verification → naira deposit account →
 * money arrives → buy crypto → sell a gift card → withdraw naira → swap →
 * sign out. Runs on the pretend providers (npm run start:e2e) and needs
 * E2E_ADMIN_* (an OWNER) for the deposit simulator, the gift-card desk and
 * the naira-payout switch. Every admin change is put back afterwards.
 */
const describeAdmin = hasAdmin ? describe : describe.skip;
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const root = join(__dirname, '..', '..');
const CODE = '424242';

type Rule = { level: string; action: string; allowed: boolean; minPerTx: string | null; maxPerTx: string | null; maxPerDay: string | null };
let ADMIN: string;
let levels: { rules: Rule[]; cooloffs: unknown[]; platform: unknown };
let user: TestUser;
let bvn: string;
let category: string, brand: string, cardType: string;
const stamp = Date.now().toString(36);

/** Waits until a balance reaches `amount`, or gives up after ~20 s. */
async function reaches(asset: string, amount: number): Promise<number> {
  let last = 0;
  for (let i = 0; i < 40; i++) {
    last = Number((await balance(user, asset).catch(() => ({ available: '0' }))).available);
    if (last >= amount) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

beforeAll(async () => {
  await requireServer();
  if (!hasAdmin) return;
  ADMIN = (await adminToken())!;
  levels = (await call('GET', '/admin/levels', { token: ADMIN })).body;
  // Local limits may be ₦0: open what the journey uses at Basic, for this run only.
  const opened = new Set(['NGN_DEPOSIT', 'NGN_WITHDRAW', 'BUY', 'SELL', 'SWAP', 'GIFTCARD_SELL']);
  const rules = levels.rules.map((r) => (r.level === 'BASIC' && opened.has(r.action) ? { ...r, allowed: true, minPerTx: null, maxPerTx: null, maxPerDay: null } : r));
  expect((await call('PUT', '/admin/levels', { token: ADMIN, body: { rules, cooloffs: levels.cooloffs, platform: levels.platform } })).status).toBe(200);
  expect((await call('PUT', '/admin/withdrawals/ngn', { token: ADMIN, body: { enabled: true, password: PASSWORD, reason: 'e2e journey' } })).status).toBe(200);
  // A gift card to sell.
  category = (await call('PUT', '/admin/giftcards/categories', { token: ADMIN, body: { name: `E2E journey ${stamp}`, isActive: true } })).body.id;
  brand = (await call('PUT', '/admin/giftcards/brands', { token: ADMIN, body: { name: `E2E journey ${stamp}`, categoryId: category, isActive: true } })).body.id;
  cardType = (await call('PUT', '/admin/giftcards/types', {
    token: ADMIN,
    body: { brandId: brand, name: 'E2E card', currency: 'USD', minAmount: '10', maxAmount: '500', rateNgn: '1000', isActive: true },
  })).body.id;
});

afterAll(async () => {
  if (!hasAdmin || !levels) return;
  await call('PUT', '/admin/levels', { token: ADMIN, body: { rules: levels.rules, cooloffs: levels.cooloffs, platform: levels.platform } });
  await call('POST', '/admin/withdrawals/ngn/reset', { token: ADMIN, body: { password: PASSWORD, reason: 'e2e journey done', confirmInFlight: true } });
  if (cardType) await call('PUT', '/admin/giftcards/types', { token: ADMIN, body: { id: cardType, brandId: brand, name: 'E2E card', currency: 'USD', minAmount: '10', maxAmount: '500', rateNgn: '1000', isActive: false } });
  if (brand) await call('PUT', '/admin/giftcards/brands', { token: ADMIN, body: { id: brand, name: `E2E journey ${stamp}`, categoryId: category, isActive: false } });
  if (category) await call('PUT', '/admin/giftcards/categories', { token: ADMIN, body: { id: category, name: `E2E journey ${stamp}`, isActive: false } });
});

describeAdmin('the whole customer journey, start to finish', () => {
  it('1. signs up and gets a session; the email is not confirmed yet', async () => {
    const email = `e2e-journey-${randomUUID().slice(0, 8)}@davochain.invalid`;
    const password = `E2e-${randomUUID().slice(0, 10)}-9`;
    const r = await call('POST', '/auth/register', { body: { email, password, firstName: 'Journey', lastName: 'Tester', phone: uniquePhone() } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String) });
    user = { id: r.body.userId, email, password, phone: '', token: r.body.accessToken, refreshToken: r.body.refreshToken };
    expect((await call('GET', '/me', { token: user.token })).body).toMatchObject({ email, emailVerified: false });
  });

  it('2. money is closed until the email is confirmed; the emailed code confirms it', async () => {
    const blocked = await call('POST', '/deposits/ngn/account', { token: user.token, body: {} });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('EMAIL_NOT_VERIFIED');

    expect((await call('POST', '/auth/email/send-code', { token: user.token })).status).toBe(200);
    // The test server has no inbox: put a known code on the one just emailed, then type it like a customer.
    execSync(`node scripts/dev-verify-email.mjs --email ${user.email} --set-code ${CODE}`, { cwd: root, stdio: 'ignore' });
    const wrong = await call('POST', '/auth/email/verify', { token: user.token, body: { code: '000000' } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toBe('That code is not right. 4 tries left.');
    const ok = await call('POST', '/auth/email/verify', { token: user.token, body: { code: CODE } });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ verified: true });
    expect((await call('GET', '/me', { token: user.token })).body.emailVerified).toBe(true);
  });

  it('3. Basic verification approves (Dojah mock), then a fresh sign-in', async () => {
    bvn = idNumber('333');
    const r = await call('POST', '/kyc/basic', {
      token: user.token,
      body: { idType: 'BVN', idNumber: bvn, firstName: 'Someone', lastName: 'Clean', dateOfBirth: '1995-03-03', address: ADDRESS, stateOfOrigin: 'Lagos', country: 'NG' },
    });
    expect(r.status).toBe(201);
    expect(r.body.state).toBe('APPROVED');
    user = await login(user);
    expect((await call('GET', '/kyc', { token: user.token })).body).toMatchObject({ level: 'BASIC', tier: 'TIER_1', status: 'APPROVED' });
  });

  it('4. opens a naira deposit account (Payrep), and asking again returns the same one', async () => {
    const r = await call('POST', '/deposits/ngn/account', { token: user.token, body: { bvn } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ accountNumber: expect.stringMatching(/^\d{10}$/), bankName: 'Payrep MFB', status: 'ACTIVE' });
    const again = await call('POST', '/deposits/ngn/account', { token: user.token, body: { bvn } });
    expect(again.body.accountNumber).toBe(r.body.accountNumber);
  });

  it('5. a ₦200,000 bank transfer arrives and is credited once', async () => {
    const sim = await call('POST', '/admin/dev/payrep/simulate-deposit', { token: ADMIN, body: { userId: user.id, amount: '200000', payerName: 'SOMEONE CLEAN' } });
    expect(sim.status).toBe(200);
    expect(await reaches('ngn', 200000)).toBe(200000);
  });

  it('6. buys crypto: quote, then execute; balances move by exactly the quote', async () => {
    const q = await call('POST', '/quotes', { token: user.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'usdt', amount: '50000' } });
    expect(q.status).toBe(201);
    const t = await call('POST', '/trades', { token: user.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': key() } });
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ status: 'COMPLETED' });
    expect(Number((await balance(user, 'ngn')).available)).toBe(150000);
    // What the trade says arrived (USDT has 6 decimal places; the quote shows 8).
    // USDT has 6 decimal places but the trade states 8 (OPEN_ISSUES C11): what arrives is the trade's amount cut to 6.
    expect(Number((await balance(user, 'usdt')).available)).toBeCloseTo(Number(t.body.toAmount), 5);
    expect(t.body.toAmount).toBe(q.body.toAmount);
  });

  it('7. sells a gift card; an admin approves it and the naira lands', async () => {
    const before = Number((await balance(user, 'ngn')).available);
    const sale = await call('POST', '/giftcards/trades', { token: user.token, body: { typeId: cardType, faceValue: '50', code: 'E2E-CARD-1234' } });
    expect(sale.status).toBe(201);
    const approve = await call('POST', `/admin/giftcards/trades/${sale.body.id}/approve`, { token: ADMIN, body: { actualRateNgn: '1000' } });
    expect(approve.status).toBe(200);
    expect(await reaches('ngn', before + 50 * 1000)).toBe(before + 50 * 1000);
  });

  it('8. withdraws naira to a saved bank account (rail mock)', async () => {
    const saved = await call('POST', '/me/bank-accounts', { token: user.token, body: { bankCode: '000014', accountNumber: '0123456789', password: user.password } });
    expect(saved.status).toBe(201);
    const before = await balance(user, 'ngn');
    const w = await call('POST', '/withdrawals/ngn', { token: user.token, body: { amount: '10000', savedBankAccountId: saved.body.id }, headers: { 'Idempotency-Key': key() } });
    expect(w.status).toBe(201);
    expect(w.body).toMatchObject({ status: 'PROCESSING', asset: 'ngn', accountNumberLast4: '6789' });
    const after = await balance(user, 'ngn');
    expect(Number(after.available)).toBeLessThanOrEqual(Number(before.available) - 10000);
  });

  it('9. swaps crypto to crypto', async () => {
    const usdt = Number((await balance(user, 'usdt')).available);
    const q = await call('POST', '/quotes', { token: user.token, body: { side: 'swap', fromAsset: 'usdt', toAsset: 'btc', amount: (usdt / 2).toFixed(2) } });
    expect(q.status).toBe(201);
    const t = await call('POST', '/trades', { token: user.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': key() } });
    expect(t.status).toBe(201);
    // A swap finishes when Quidax confirms it: PROCESSING first, then COMPLETED.
    let status = t.body.status;
    for (let i = 0; i < 40 && status !== 'COMPLETED'; i++) {
      await new Promise((r) => setTimeout(r, 500));
      status = (await call('GET', `/trades/${t.body.transactionId}`, { token: user.token })).body.status;
    }
    expect(status).toBe('COMPLETED');
    expect(Number((await balance(user, 'btc')).available)).toBeCloseTo(Number(t.body.toAmount), 8);
    expect(Number((await balance(user, 'usdt')).available)).toBeCloseTo(usdt - Number(t.body.fromAmount), 6);
  });

  it('10. signs out: the refresh token stops working', async () => {
    expect((await call('POST', '/auth/logout', { token: user.token, body: { refreshToken: user.refreshToken } })).status).toBe(204);
    expect((await call('POST', '/auth/refresh', { body: { refreshToken: user.refreshToken } })).status).toBe(401);
  });
});
