import { adminToken, call, hasAdmin, newUser, requireServer, uniquePhone, verifyBasic, type Res, type TestUser } from './helpers';
import { randomUUID } from 'node:crypto';

/**
 * Every rate limit, over real HTTP, at its REAL default (launch request, 22 Oct 2026).
 *
 * Opt-in: RATE_LIMIT_E2E=yes, against a server started with
 *   npm run start:e2e -- 3001 --real-limits
 * after clearing the old counters (test/e2e/README.md, "Rate limits"). Run this
 * file on its own: it uses up the limits for this machine's address for up to
 * an hour, so other e2e files would then see 429s.
 *
 * Each test sends one request more than the limit allows and checks that the
 * last one is refused with 429, the "Try again in N seconds" message and a
 * Retry-After header, and that none before it was a 429.
 */
const run = process.env.RATE_LIMIT_E2E === 'yes' ? describe : describe.skip;
const email = () => `e2e-rl-${randomUUID().slice(0, 10)}@davochain.invalid`;

/** Sends `n` requests one after another; returns every answer. */
async function times(n: number, send: (i: number) => Promise<Res>): Promise<Res[]> {
  const out: Res[] = [];
  for (let i = 0; i < n; i++) out.push(await send(i));
  return out;
}
/** Sends `n` requests, `width` at a time (for the big limits). */
async function burst(n: number, width: number, send: () => Promise<Res>): Promise<Res[]> {
  const out: Res[] = [];
  for (let i = 0; i < n; i += width) out.push(...(await Promise.all(Array.from({ length: Math.min(width, n - i) }, send))));
  return out;
}

function limited(r: Res): void {
  expect(r.status).toBe(429);
  expect(r.body.message).toMatch(/^Too many attempts\. Try again in \d+ seconds\.$/);
  expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
}
/** Exactly `allowed` pass the limiter, and the next one is refused. */
function exactly(rs: Res[], allowed: number): void {
  expect(rs.slice(0, allowed).filter((r) => r.status === 429)).toHaveLength(0);
  limited(rs[allowed]);
}

let ADMIN: string | null = null;
let a: TestUser; // a plain customer, email confirmed
let b: TestUser; // a Basic-verified customer
let levels: { rules: Array<Record<string, unknown>>; cooloffs: unknown[]; platform: unknown } | null = null;

beforeAll(async () => {
  if (process.env.RATE_LIMIT_E2E !== 'yes') return;
  await requireServer();
  a = await newUser('Rate', 'LimitA'); // registration 1 of 5
  b = await verifyBasic(await newUser('Rate', 'LimitB')); // registration 2 of 5; kyc.basic 1 of 5 for b
  if (hasAdmin) {
    ADMIN = await adminToken();
    levels = (await call('GET', '/admin/levels', { token: ADMIN })).body;
    const rules = levels!.rules.map((r) => (r.level === 'BASIC' && r.action === 'GIFTCARD_SELL' ? { ...r, allowed: true, minPerTx: null, maxPerTx: null, maxPerDay: null } : r));
    await call('PUT', '/admin/levels', { token: ADMIN, body: { rules, cooloffs: levels!.cooloffs, platform: levels!.platform } });
  }
});

afterAll(async () => {
  if (ADMIN && levels) await call('PUT', '/admin/levels', { token: ADMIN, body: { rules: levels.rules, cooloffs: levels.cooloffs, platform: levels.platform } });
});

run('rate limits at their real defaults', () => {
  it('auth.login: 10 per email per 15 min (customer and admin sign-in share it)', async () => {
    const e = email();
    exactly(await times(11, () => call('POST', '/auth/login', { body: { email: e, password: 'Wrong-password-1' } })), 10);
    const admin = email();
    exactly(await times(11, () => call('POST', '/admin/auth/login', { body: { email: admin, password: 'Wrong-password-1' } })), 10);
  });

  it('auth.login: 20 per address per 15 min', async () => {
    // Earlier sign-ins from this address already count, so the 429 comes within 20 more.
    const rs = await times(21, () => call('POST', '/auth/login', { body: { email: email(), password: 'Wrong-password-1' } }));
    const first = rs.findIndex((r) => r.status === 429);
    expect(first).toBeGreaterThanOrEqual(0);
    limited(rs[first]);
  });

  it('auth.reset (request a reset code): 3 per email per hour, 10 per address', async () => {
    const e = email();
    exactly(await times(4, () => call('POST', '/auth/reset/request', { body: { email: e } })), 3);
    const rs = await times(8, () => call('POST', '/auth/reset/request', { body: { email: email() } }));
    expect(rs.findIndex((r) => r.status === 429)).toBeGreaterThanOrEqual(0);
  });

  it('auth.resetConfirm (type the reset code): 10 per email per hour, 20 per address', async () => {
    const e = email();
    const body = { email: e, code: '000000', newPassword: 'New-password-123' };
    exactly(await times(11, () => call('POST', '/auth/reset/confirm', { body })), 10);
    const rs = await times(11, () => call('POST', '/auth/reset/confirm', { body: { ...body, email: email() } }));
    expect(rs.findIndex((r) => r.status === 429)).toBeGreaterThanOrEqual(0);
  });

  it('auth.refresh: 60 per address per minute', async () => {
    const rs = await times(61, () => call('POST', '/auth/refresh', { body: { refreshToken: 'not-a-token' } }));
    exactly(rs, 60);
  });

  it('auth.emailCode (send the email code): 5 per customer per hour', async () => {
    exactly(await times(6, () => call('POST', '/auth/email/send-code', { token: a.token })), 5);
  });

  it('auth.emailVerify (type the email code): 10 per customer per hour', async () => {
    exactly(await times(11, () => call('POST', '/auth/email/verify', { token: a.token, body: { code: '000000' } })), 10);
  });

  it('auth.changePassword: 5 per customer per hour', async () => {
    exactly(await times(6, () => call('POST', '/auth/change-password', { token: a.token, body: { currentPassword: 'Wrong-password-1', newPassword: 'New-password-123' } })), 5);
  });

  it('kyc.basic: 5 per customer per hour', async () => {
    exactly(await times(6, () => call('POST', '/kyc/basic', { token: a.token, body: {} })), 5);
  });

  it('kyc.documents: 20 per customer per hour', async () => {
    exactly(await times(21, () => call('POST', '/kyc/documents', { token: a.token, body: {} })), 20);
  });

  it('kyc.advanced: 10 per customer per hour (identity and address together)', async () => {
    const rs = await times(11, (i) => call('POST', i % 2 ? '/kyc/advanced/address' : '/kyc/advanced/identity', { token: b.token, body: {} }));
    exactly(rs, 10);
  });

  (hasAdmin ? it : it.skip)('giftcards.sell: 30 per customer per hour', async () => {
    exactly(await times(31, () => call('POST', '/giftcards/trades', { token: b.token, body: { typeId: randomUUID(), faceValue: '10' } })), 30);
  });

  it('auth.register: 5 per address per hour', async () => {
    // a and b used 2 of the 5.
    const rs = await times(4, () =>
      call('POST', '/auth/register', { body: { email: email(), password: `E2e-${randomUUID().slice(0, 10)}-9`, firstName: 'Rate', lastName: 'Limit', phone: uniquePhone() } }),
    );
    exactly(rs, 3);
  });

  it('public routes: 120 per address per minute', async () => {
    const rs = await burst(121, 20, () => call('GET', '/assets'));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(120);
    limited(rs.find((r) => r.status === 429)!);
  });

  it('webhooks: 3000 per address per minute', async () => {
    const rs = await burst(3001, 100, () => call('POST', '/webhooks/payrep', { body: {} }));
    expect(rs.filter((r) => r.status === 429)).toHaveLength(1);
    limited(rs.find((r) => r.status === 429)!);
  });

  it('every other route: 300 per customer per minute', async () => {
    const rs = await burst(301, 30, () => call('GET', '/wallets', { token: a.token }));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(300);
    limited(rs.find((r) => r.status === 429)!);
  });
});
