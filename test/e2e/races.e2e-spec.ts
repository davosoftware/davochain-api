import { balance, call, credit, key, login, newUser, requireServer, verifyBasic, type TestUser } from './helpers';

/**
 * Tight races and repeated requests over real HTTP (launch request, 22 Oct 2026).
 * Every test fires its requests at the same moment with Promise.all and then
 * checks that money moved once, sessions were made once, and nothing crashed.
 */
beforeAll(requireServer);

const together = <T>(n: number, fn: (i: number) => Promise<T>) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
const statuses = (rs: Array<{ status: number }>) => rs.map((r) => r.status).sort();

describe('racing sign-ins (request coalescing)', () => {
  it('5 identical sign-ins at once share ONE session: every answer carries the same refresh token', async () => {
    const u = await newUser();
    const rs = await together(5, () => call('POST', '/auth/login', { body: { email: u.email, password: u.password } }));
    expect(statuses(rs)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(rs.map((r) => r.body.refreshToken)).size).toBe(1);
    // And that one session works.
    const refreshed = await call('POST', '/auth/refresh', { body: { refreshToken: rs[0].body.refreshToken } });
    expect(refreshed.status).toBe(200);
  });

  it('5 identical wrong passwords at once: all 401, counted as ONE failure (not a lockout)', async () => {
    const u = await newUser();
    const rs = await together(5, () => call('POST', '/auth/login', { body: { email: u.email, password: 'Wrong-password-1' } }));
    expect(statuses(rs)).toEqual([401, 401, 401, 401, 401]);
    // 5 separate failures would lock the account (403); one counted failure does not.
    expect((await call('POST', '/auth/login', { body: { email: u.email, password: u.password } })).status).toBe(200);
  });

  it('once a sign-in has finished, the next one is a new session', async () => {
    const u = await newUser();
    const a = await call('POST', '/auth/login', { body: { email: u.email, password: u.password } });
    const b = await call('POST', '/auth/login', { body: { email: u.email, password: u.password } });
    expect(a.body.refreshToken).not.toBe(b.body.refreshToken);
  });

  it('two refreshes with the same token at once: exactly one wins, and the session survives', async () => {
    const u = await newUser();
    const rs = await together(2, () => call('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } }));
    expect(statuses(rs)).toEqual([200, 401]);
    const winner = rs.find((r) => r.status === 200)!;
    expect((await call('POST', '/auth/refresh', { body: { refreshToken: winner.body.refreshToken } })).status).toBe(200);
  });
});

describe('racing money requests', () => {
  let user: TestUser;
  beforeAll(async () => {
    user = await verifyBasic(await newUser());
    credit(user, 'ngn', '300000');
  });

  it('one quote executed 3 times at once with 3 different keys: one trade, charged once', async () => {
    const before = Number((await balance(user, 'ngn')).available);
    const q = await call('POST', '/quotes', { token: user.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'usdt', amount: '20000' } });
    expect(q.status).toBe(201);
    const rs = await together(3, () => call('POST', '/trades', { token: user.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': key() } }));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.every((r) => r.status < 500)).toBe(true);
    expect(Number((await balance(user, 'ngn')).available)).toBe(before - 20000);
  });

  it('the same Idempotency-Key sent twice at once: the trade happens once; the copy is "still processing" or the same answer', async () => {
    const before = Number((await balance(user, 'ngn')).available);
    const q = await call('POST', '/quotes', { token: user.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'usdt', amount: '10000' } });
    const k = key();
    const rs = await together(2, () => call('POST', '/trades', { token: user.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': k } }));
    expect(rs.some((r) => r.status === 201)).toBe(true);
    for (const r of rs) expect([201, 409]).toContain(r.status);
    expect(Number((await balance(user, 'ngn')).available)).toBe(before - 10000);
    // Afterwards the same key replays the same trade.
    const replay = await call('POST', '/trades', { token: user.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': k } });
    expect(replay.status).toBe(201);
    expect(replay.body.transactionId).toBe(rs.find((r) => r.status === 201)!.body.transactionId);
  });

  it('the same Idempotency-Key with a different body is refused (409), nothing moves', async () => {
    const k = key();
    const q1 = await call('POST', '/quotes', { token: user.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'usdt', amount: '15000' } });
    expect((await call('POST', '/trades', { token: user.token, body: { quoteId: q1.body.quoteId }, headers: { 'Idempotency-Key': k } })).status).toBe(201);
    const q2 = await call('POST', '/quotes', { token: user.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'usdt', amount: '15000' } });
    const before = Number((await balance(user, 'ngn')).available);
    const other = await call('POST', '/trades', { token: user.token, body: { quoteId: q2.body.quoteId }, headers: { 'Idempotency-Key': k } });
    expect(other.status).toBe(409);
    expect(Number((await balance(user, 'ngn')).available)).toBe(before);
  });

  it('10 buys at once that together cost more than the balance: the balance never goes below zero', async () => {
    const poor = await verifyBasic(await newUser());
    credit(poor, 'ngn', '30000');
    const quotes = await together(10, () => call('POST', '/quotes', { token: poor.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'usdt', amount: '10000' } }));
    const ok = quotes.filter((q) => q.status === 201);
    const rs = await Promise.all(ok.map((q) => call('POST', '/trades', { token: poor.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': key() } })));
    expect(rs.filter((r) => r.status === 201).length).toBeLessThanOrEqual(3);
    expect(rs.every((r) => r.status < 500)).toBe(true);
    const b = await balance(poor, 'ngn');
    expect(Number(b.available)).toBeGreaterThanOrEqual(0);
    expect(Number(b.available) + 10000 * rs.filter((r) => r.status === 201).length).toBe(30000);
  });

  it('opening the naira deposit account 3 times at once gives ONE account', async () => {
    const u = await verifyBasic(await newUser());
    const rs = await together(3, () => call('POST', '/deposits/ngn/account', { token: u.token, body: {} }));
    // 201 for the one that opened it, 200 for "already had one", 202 for "being opened right now".
    expect(rs.every((r) => [200, 201, 202].includes(r.status))).toBe(true);
    let mine = await call('GET', '/deposits/ngn/account', { token: u.token });
    for (let i = 0; i < 20 && mine.status === 202; i++) {
      await new Promise((res) => setTimeout(res, 500));
      mine = await call('GET', '/deposits/ngn/account', { token: u.token });
    }
    expect(mine.status).toBe(200);
    const numbers = new Set(rs.filter((r) => r.body.accountNumber).map((r) => r.body.accountNumber));
    expect(numbers.size).toBeLessThanOrEqual(1);
    for (const n of numbers) expect(n).toBe(mine.body.accountNumber);
  });
});

describe('racing email confirmations', () => {
  it('two different codes typed at once never confirm a wrong code', async () => {
    const u = await newUser('Race', 'Email', { verifyEmail: false });
    await call('POST', '/auth/email/send-code', { token: u.token });
    const rs = await together(2, (i) => call('POST', '/auth/email/verify', { token: u.token, body: { code: i ? '000001' : '000002' } }));
    expect(rs.every((r) => r.status === 400 || r.status === 200)).toBe(true);
    const me = (await call('GET', '/me', { token: (await login(u)).token })).body;
    // Two random wrong codes: confirmed only if one happened to be right (1 in 500,000).
    expect(me.emailVerified).toBe(rs.some((r) => r.status === 200));
  });
});
