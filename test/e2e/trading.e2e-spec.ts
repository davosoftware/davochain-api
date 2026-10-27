import { balance, call, credit, key, MONEY, newUser, requireServer, verifyBasic, type TestUser } from './helpers';

let user: TestUser;

beforeAll(async () => {
  await requireServer();
  user = await verifyBasic(await newUser());
  credit(user, 'ngn', '500000');
});

const quote = (u: TestUser, body: Record<string, unknown>) => call('POST', '/quotes', { token: u.token, body });
const BUY = { side: 'buy', fromAsset: 'ngn', toAsset: 'btc', amount: '50000' };

describe('quotes (POST /v1/quotes)', () => {
  it('a buy quote: amounts as strings, single use, 12 seconds to live', async () => {
    const r = await quote(user, BUY);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ quoteId: expect.any(String), side: 'BUY', fromAsset: 'ngn', toAsset: 'btc', ttlSeconds: 12 });
    for (const f of ['fromAmount', 'toAmount', 'rate', 'fee', 'availableBalance']) expect(r.body[f]).toMatch(MONEY);
    expect(new Date(r.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('above the single-trade cap is 400 naming the cap', async () => {
    const r = await quote(user, { ...BUY, amount: '999999999' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/^Maximum single trade is \$/);
  });

  it('under the cap but more than the balance is 400 naming the balance', async () => {
    const r = await quote(user, { ...BUY, amount: '2000000' }); // ~$1,350: under the cap, over the ₦500,000 credited
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/^Insufficient naira balance. You have ₦/);
  });

  it.each(['abc', '', '-5', '1,000'])('amount %p is 400, never 500', async (amount) => {
    const r = await quote(user, { ...BUY, amount });
    expect(r.status).toBe(400);
  });

  it('an unknown side is 400', async () => {
    const r = await quote(user, { ...BUY, side: 'gift' });
    expect(r.status).toBe(400);
  });
});

describe('trades (POST /v1/trades)', () => {
  it('requires an Idempotency-Key', async () => {
    const q = await quote(user, BUY);
    const r = await call('POST', '/trades', { token: user.token, body: { quoteId: q.body.quoteId } });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Idempotency-Key header is required for this request');
  });

  it('a buy completes, and the balances move by exactly the quoted amounts', async () => {
    const ngnBefore = await balance(user, 'ngn');
    const btcBefore = await balance(user, 'btc');
    const q = await quote(user, BUY);
    const r = await call('POST', '/trades', { token: user.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': key() } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ transactionId: expect.any(String), status: 'COMPLETED', fromAsset: 'ngn', toAsset: 'btc' });
    const ngnAfter = await balance(user, 'ngn');
    const btcAfter = await balance(user, 'btc');
    expect(Number(ngnBefore.available) - Number(ngnAfter.available)).toBeCloseTo(Number(r.body.fromAmount), 2);
    expect(Number(btcAfter.available) - Number(btcBefore.available)).toBeCloseTo(Number(r.body.toAmount), 8);
  });

  it('the same Idempotency-Key twice returns the same trade and charges once', async () => {
    const q = await quote(user, BUY);
    const k = key();
    const first = await call('POST', '/trades', { token: user.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': k } });
    const ngnAfterFirst = await balance(user, 'ngn');
    const second = await call('POST', '/trades', { token: user.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': k } });
    expect(second.status).toBe(first.status);
    expect(second.body.transactionId).toBe(first.body.transactionId);
    expect((await balance(user, 'ngn')).available).toBe(ngnAfterFirst.available);
  });

  it('a quote cannot be used twice, even with a new key', async () => {
    const q = await quote(user, BUY);
    await call('POST', '/trades', { token: user.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': key() } });
    const r = await call('POST', '/trades', { token: user.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': key() } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it("another user cannot execute or see someone else's quote or trade", async () => {
    const q = await quote(user, BUY);
    const other = await verifyBasic(await newUser());
    const use = await call('POST', '/trades', { token: other.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': key() } });
    expect(use.status).toBe(404);
    const mine = await call('POST', '/trades', { token: user.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': key() } });
    const peek = await call('GET', `/trades/${mine.body.transactionId}`, { token: other.token });
    expect(peek.status).toBe(404);
  });

  it('the trade appears in history and can be fetched by id', async () => {
    const q = await quote(user, BUY);
    const t = await call('POST', '/trades', { token: user.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': key() } });
    const list = await call('GET', '/trades?limit=50', { token: user.token });
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: string }>).map((x) => x.id)).toContain(t.body.transactionId);
    const one = await call('GET', `/trades/${t.body.transactionId}`, { token: user.token });
    expect(one.body).toMatchObject({ id: t.body.transactionId, type: 'BUY', status: 'COMPLETED' });
  });

  it('a buy never creates a deposit (the old "phantom deposit" bug)', async () => {
    const before = (await call('GET', '/deposits', { token: user.token })).body.length;
    const q = await quote(user, BUY);
    await call('POST', '/trades', { token: user.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': key() } });
    expect((await call('GET', '/deposits', { token: user.token })).body.length).toBe(before);
  });

  it('a buy sends one "trade.completed" notification', async () => {
    const n = await call('GET', '/notifications', { token: user.token });
    expect(n.status).toBe(200);
    expect((n.body.items as Array<{ type: string }>).every((i) => i.type !== 'deposit.credited')).toBe(true);
    expect((n.body.items as Array<{ type: string }>).some((i) => i.type === 'trade.completed')).toBe(true);
  });
});

/**
 * Swaps (27 Oct 2026): priced from Quidax's own live swap quotation with our fee
 * on top, so the customer is credited exactly what they were quoted; and a tap
 * after Quidax's 15-second quotation expired still goes through at a fresh
 * price when it moved less than 0.5%.
 */
describe('swaps (POST /v1/quotes side=swap, then /v1/trades)', () => {
  const SWAP = { side: 'swap', fromAsset: 'usdt', toAsset: 'btc', amount: '50' };

  beforeAll(() => credit(user, 'usdt', '200'));

  async function finished(id: string): Promise<Record<string, string>> {
    let t = (await call('GET', `/trades/${id}`, { token: user.token })).body;
    for (let i = 0; i < 40 && t.status !== 'COMPLETED' && t.status !== 'FAILED'; i++) {
      await new Promise((r) => setTimeout(r, 500));
      t = (await call('GET', `/trades/${id}`, { token: user.token })).body;
    }
    return t;
  }

  it('the customer is credited exactly the quoted amount, and the swap shows its fee', async () => {
    const before = Number((await balance(user, 'btc')).available);
    const q = await quote(user, SWAP);
    expect(q.status).toBe(201);
    expect(q.body).toMatchObject({ side: 'SWAP', feeAsset: 'btc' });
    const t = await call('POST', '/trades', { token: user.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': key() } });
    expect(t.status).toBe(201);
    const done = await finished(t.body.transactionId);
    expect(done.status).toBe('COMPLETED');
    // Exactly what Quidax delivered minus our fee: the quote, plus at most rounding dust (the quote is rounded down).
    const credited = Number(done.toAmount);
    expect(credited).toBeGreaterThanOrEqual(Number(q.body.toAmount));
    expect(credited - Number(q.body.toAmount)).toBeLessThan(0.0000001);
    expect(Number((await balance(user, 'btc')).available) - before).toBeCloseTo(credited, 7); // the wallet shows 8 decimals
    expect(done).toMatchObject({ feeAsset: 'btc' });
    expect(Number(done.fee)).toBeGreaterThan(0);
    expect(Number(done.rate)).toBeGreaterThan(0); // a small rate keeps its digits, never "0.0000"
  });

  it("tapping Swap after Quidax's 15-second price expired still goes through, at the refreshed price", async () => {
    const q = await quote(user, SWAP);
    expect(q.status).toBe(201);
    await new Promise((r) => setTimeout(r, 16_000)); // Quidax's quotation is gone; ours is within the 30-second hard expiry
    const t = await call('POST', '/trades', { token: user.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': key() } });
    expect(t.status).toBe(201);
    const done = await finished(t.body.transactionId);
    expect(done.status).toBe('COMPLETED');
    // The pretend Quidax's prices don't move, so the refreshed price is the same (give or take rounding dust).
    expect(Math.abs(Number(done.toAmount) - Number(q.body.toAmount))).toBeLessThan(0.0000001);
  }, 40_000);
});
