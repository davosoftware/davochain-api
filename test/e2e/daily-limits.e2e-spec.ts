import { adminToken, call, credit, hasAdmin, key, newUser, requireServer, verifyBasic, type TestUser } from './helpers';

/**
 * People → Daily limits (27 Oct 2026) over real HTTP: after a real buy, the
 * admin monitor shows the same "used today" as the customer's own limits
 * (GET /v1/me/level), which is what the limits check enforces.
 */
const describeAdmin = hasAdmin ? describe : describe.skip;
let ADMIN: string;
let user: TestUser;

beforeAll(async () => {
  await requireServer();
  if (!hasAdmin) return;
  ADMIN = (await adminToken())!;
  user = await verifyBasic(await newUser('Limits', 'Watcher'));
  credit(user, 'ngn', '200000');
  const q = await call('POST', '/quotes', { token: user.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'btc', amount: '50000' } });
  expect(q.status).toBe(201);
  const t = await call('POST', '/trades', { token: user.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': key() } });
  expect(t.status).toBe(201);
});

describeAdmin('Admin: daily limits', () => {
  it("one customer's day matches what the limits check counted for them", async () => {
    const mine = await call('GET', '/me/level', { token: user.token });
    expect(mine.status).toBe(200);
    const theirBuy = mine.body.actions.find((a: { action: string }) => a.action === 'BUY');

    const r = await call('GET', `/admin/users/${user.id}/limits`, { token: ADMIN });
    expect(r.status).toBe(200);
    const buy = r.body.customer.actions.find((a: { action: string }) => a.action === 'BUY');
    expect(Number(buy.used)).toBeGreaterThan(0);
    expect(buy.used).toBe(theirBuy.usedToday);
    expect(buy.currency).toBe(theirBuy.currency);
    expect(r.body.customer).toMatchObject({ userId: user.id, email: user.email, level: 'BASIC' });
  });

  it('the day list includes the customer, searchable, with paging', async () => {
    const r = await call('GET', `/admin/limits/daily?search=${encodeURIComponent(user.email)}`, { token: ADMIN });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 1, page: 1, pageSize: 25 });
    expect(r.body.customers[0]).toMatchObject({ userId: user.id });
  });

  it('a past day with nothing in it is empty; a bad date is refused', async () => {
    expect((await call('GET', `/admin/limits/daily?date=2020-01-01&search=${encodeURIComponent(user.email)}`, { token: ADMIN })).body.total).toBe(0);
    expect((await call('GET', '/admin/limits/daily?date=2026-13-40', { token: ADMIN })).status).toBe(400);
  });
});
