/**
 * The transaction PIN (29 Oct 2026), against a running server: create it,
 * the four routes that ask for it, wrong tries and the lock, change, and
 * Forgot PIN. docs/TRANSACTION_PIN.md is the app's guide to the same steps.
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { E2E_PIN, adminToken, balance, call, credit, hasAdmin, key, newUser, requireServer, verifyBasic, type TestUser } from './helpers';

const root = join(__dirname, '..', '..');

const describeAdmin = hasAdmin ? describe : describe.skip;

describeAdmin('transaction PIN', () => {
  let ADMIN: string;
  let original: { rules: unknown[]; cooloffs: Array<Record<string, unknown>>; platform: unknown };
  let ada: TestUser;
  let bob: TestUser;
  let bobName: string;

  beforeAll(async () => {
    await requireServer();
    ADMIN = (await adminToken())!;
    // No waits for new accounts or new payees in this run; the wait after a
    // credential change stays on, because Forgot PIN must start it.
    original = (await call('GET', '/admin/levels', { token: ADMIN })).body;
    const cooloffs = original.cooloffs.map((c) => ({ ...c, afterNewPayeeHours: 0, afterSignupHours: 0, afterCredentialChangeHours: 24 }));
    expect((await call('PUT', '/admin/levels', { token: ADMIN, body: { rules: original.rules, cooloffs, platform: original.platform } })).status).toBe(200);

    ada = await verifyBasic(await newUser('Ada', 'Pin', { pin: false }));
    bob = await verifyBasic(await newUser('Bob', 'Pin'));
    bobName = (await call('GET', '/me/pay-username', { token: bob.token })).body.payUsername;
    credit(ada, 'ngn', '200000');
  }, 60_000);

  afterAll(async () => {
    if (original) await call('PUT', '/admin/levels', { token: ADMIN, body: { rules: original.rules, cooloffs: original.cooloffs, platform: original.platform } });
  });

  const send = (pin: string | null, amount = '1') =>
    call('POST', '/transfers/crypto', { token: ada.token, pin, body: { username: bobName, asset: 'usdt', amount }, headers: { 'Idempotency-Key': key() } });

  it('with no PIN yet: GET says so, and a send is refused with PIN_NOT_SET', async () => {
    expect((await call('GET', '/me/transaction-pin', { token: ada.token })).body).toMatchObject({ isSet: false, lockedUntil: null });
    expect((await call('GET', '/me', { token: ada.token })).body.hasTransactionPin).toBe(false);
    const r = await send(E2E_PIN);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PIN_NOT_SET');
  });

  it('creating one needs the right password and a PIN that is not easy to guess', async () => {
    const wrongPw = await call('POST', '/me/transaction-pin', { token: ada.token, body: { password: 'not-it', pin: E2E_PIN } });
    expect(wrongPw.status).toBe(403);
    expect(wrongPw.body.code).toBe('PASSWORD_WRONG');
    const weak = await call('POST', '/me/transaction-pin', { token: ada.token, body: { password: ada.password, pin: '1234' } });
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('PIN_WEAK');
    const ok = await call('POST', '/me/transaction-pin', { token: ada.token, body: { password: ada.password, pin: E2E_PIN } });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ isSet: true, lockedUntil: null, triesLeft: 5 });
    const again = await call('POST', '/me/transaction-pin', { token: ada.token, body: { password: ada.password, pin: '7391' } });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('PIN_ALREADY_SET');
  });

  it('with the PIN, a buy goes through (so the coins really exist at Quidax)', async () => {
    const q = await call('POST', '/quotes', { token: ada.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'usdt', amount: '100000' } });
    const t = await call('POST', '/trades', { token: ada.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': key() } });
    expect(t.body.status).toBe('COMPLETED');
  });

  it('a send without the header is PIN_REQUIRED; with the right PIN it goes through', async () => {
    const none = await send(null);
    expect(none.status).toBe(403);
    expect(none.body.code).toBe('PIN_REQUIRED');
    const bobBefore = Number((await balance(bob, 'usdt')).available);
    const ok = await send(E2E_PIN);
    expect(ok.status).toBe(201);
    expect(Number((await balance(bob, 'usdt')).available)).toBeCloseTo(bobBefore + 1, 6);
  });

  it('the other money routes ask for it too; getting a price does not', async () => {
    const quote = await call('POST', '/quotes', { token: ada.token, pin: null, body: { side: 'swap', fromAsset: 'usdt', toAsset: 'btc', amount: '5' } });
    expect(quote.status).toBe(201);
    const trade = await call('POST', '/trades', { token: ada.token, pin: null, body: { quoteId: quote.body.quoteId }, headers: { 'Idempotency-Key': key() } });
    expect(trade.body.code).toBe('PIN_REQUIRED');
    const crypto = await call('POST', '/withdrawals/crypto', { token: ada.token, pin: null, body: {}, headers: { 'Idempotency-Key': key() } });
    expect(crypto.body.code).toBe('PIN_REQUIRED');
    const ngn = await call('POST', '/withdrawals/ngn', { token: ada.token, pin: null, body: {}, headers: { 'Idempotency-Key': key() } });
    expect(ngn.body.code).toBe('PIN_REQUIRED');
  });

  it('wrong PINs count down; the fifth locks it for 30 minutes, even for the right PIN', async () => {
    for (const left of [4, 3, 2, 1]) {
      const r = await send('0000');
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: 'PIN_WRONG', triesLeft: left, message: `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.` });
    }
    const fifth = await send('0000');
    expect(fifth.body.code).toBe('PIN_LOCKED');
    const minutes = (new Date(fifth.body.until).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(28);
    expect(minutes).toBeLessThanOrEqual(30);
    expect((await send(E2E_PIN)).body.code).toBe('PIN_LOCKED');
    expect((await call('GET', '/me/transaction-pin', { token: ada.token })).body).toMatchObject({ isSet: true, triesLeft: 0, lockedUntil: fifth.body.until });
  });

  it('an owner can unlock it from the dashboard', async () => {
    const admin = ADMIN;
    const detail = (await call('GET', `/admin/users/${ada.id}`, { token: admin })).body;
    expect(detail.transactionPin).toMatchObject({ isSet: true, lockedUntil: expect.any(String) });
    expect(JSON.stringify(detail)).not.toContain('scrypt$');
    const r = await call('POST', `/admin/users/${ada.id}/transaction-pin/unlock`, { token: admin });
    expect(r.status).toBe(201);
    expect((await send(E2E_PIN)).status).toBe(201);
  });

  it('change: the old PIN, then a new one', async () => {
    const wrong = await call('PUT', '/me/transaction-pin', { token: ada.token, body: { currentPin: '0000', newPin: '7391' } });
    expect(wrong.body).toMatchObject({ code: 'PIN_WRONG', triesLeft: 4 });
    const ok = await call('PUT', '/me/transaction-pin', { token: ada.token, body: { currentPin: E2E_PIN, newPin: '7391' } });
    expect(ok.status).toBe(200);
    expect((await send('7391')).status).toBe(201);
  });

  it('Forgot PIN: password, then the emailed code and a new PIN; it unlocks, and sends wait as after a password change', async () => {
    const wrongPw = await call('POST', '/me/transaction-pin/reset/request', { token: ada.token, body: { password: 'not-it' } });
    expect(wrongPw.body.code).toBe('PASSWORD_WRONG');
    const asked = await call('POST', '/me/transaction-pin/reset/request', { token: ada.token, body: { password: ada.password } });
    expect(asked.status).toBe(200);
    expect(asked.body).toEqual({ sent: true });
    execSync(`node scripts/dev-verify-email.mjs --email ${ada.email} --purpose PIN_RESET --set-code 135790`, { cwd: root, stdio: 'ignore' });
    const bad = await call('POST', '/me/transaction-pin/reset', { token: ada.token, body: { code: '000000', newPin: '5173' } });
    expect(bad.status).toBe(400);
    const ok = await call('POST', '/me/transaction-pin/reset', { token: ada.token, body: { code: '135790', newPin: '5173' } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ isSet: true, lockedUntil: null, triesLeft: 5 });
    const r = await send('5173');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('COOLING_OFF');
  });
});
