import { adminToken, call, credit, hasAdmin, key, newUser, requireServer, verifyBasic, type TestUser } from './helpers';

/**
 * One customer's trade and transfer history, and their balance check
 * (29 Oct 2026): the dashboard's way to trace a discrepancy.
 */
const describeAdmin = hasAdmin ? describe : describe.skip;

jest.setTimeout(120_000);

describeAdmin('one customer\'s history and balance check (admin)', () => {
  let ADMIN: string;
  let alice: TestUser;
  let bob: TestUser;
  let aliceId: string;
  let bobId: string;

  beforeAll(async () => {
    await requireServer();
    ADMIN = (await adminToken())!;
    alice = await verifyBasic(await newUser('Alice', 'History'));
    bob = await verifyBasic(await newUser('Bob', 'History'));
    aliceId = (await call('GET', '/me', { token: alice.token })).body.id;
    bobId = (await call('GET', '/me', { token: bob.token })).body.id;

    // Alice buys USDT and sends 5 to Bob by username.
    credit(alice, 'ngn', '100000');
    const q = await call('POST', '/quotes', { token: alice.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'usdt', amount: '50000' } });
    expect((await call('POST', '/trades', { token: alice.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': key() } })).body.status).toBe('COMPLETED');
    const username = (await call('GET', '/me/pay-username', { token: bob.token })).body.payUsername;
    const sent = await call('POST', '/transfers/crypto', { token: alice.token, body: { username, asset: 'usdt', amount: '5' }, headers: { 'Idempotency-Key': key() } });
    expect(sent.body.status).toBe('COMPLETED');
  });

  it('the manager narrowed to Alice shows only her rows, and its counts are hers', async () => {
    const r = await call('GET', `/admin/transactions/manager?userId=${aliceId}&pageSize=50`, { token: ADMIN });
    expect(r.status).toBe(200);
    expect(r.body.total).toBeGreaterThanOrEqual(2);
    expect(r.body.rows.every((t: { userId: string }) => t.userId === aliceId)).toBe(true);
    expect(r.body.counts.BUY).toBe(1);
    expect(r.body.counts.WITHDRAWAL).toBe(1);
    // The send names Bob, with each step at Quidax.
    const send = r.body.rows.find((t: { type: string }) => t.type === 'WITHDRAWAL');
    expect(send.peer).toMatchObject({ userId: bobId });
    expect(send.legs).toEqual([expect.objectContaining({ kind: 'PEER_TRANSFER', state: 'CONFIRMED' })]);
  });

  it('Bob\'s history shows the 5 USDT arriving from Alice', async () => {
    const r = await call('GET', `/admin/transactions/manager?userId=${bobId}&asset=usdt`, { token: ADMIN });
    expect(r.body.rows).toEqual([expect.objectContaining({ type: 'DEPOSIT', status: 'COMPLETED', toAsset: 'usdt', peer: expect.objectContaining({ userId: aliceId }) })]);
  });

  it('a coin filter keeps only that coin; the export follows the same filters', async () => {
    const r = await call('GET', `/admin/transactions/manager?userId=${aliceId}&asset=btc`, { token: ADMIN });
    expect(r.body.total).toBe(0);
    const csv = await call('GET', `/admin/transactions/manager/export?userId=${aliceId}`, { token: ADMIN });
    expect(csv.body.rows.length).toBeGreaterThanOrEqual(2);
    expect(csv.body.rows.every((t: { userId: string }) => t.userId === aliceId)).toBe(true);
  });

  it('nonsense filters are refused, not ignored', async () => {
    expect((await call('GET', '/admin/transactions/manager?userId=not-an-id', { token: ADMIN })).status).toBe(400);
    expect((await call('GET', `/admin/transactions/manager?userId=${aliceId}&asset=%25%25`, { token: ADMIN })).status).toBe(400);
  });

  it('the balance check: Alice\'s USDT matches in our records and at Quidax; Bob\'s too', async () => {
    const a = await call('GET', `/admin/users/${aliceId}/balance-check`, { token: ADMIN });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ userId: aliceId, quidax: 'READ' });
    const usdt = a.body.rows.find((r: { asset: string }) => r.asset === 'usdt');
    expect(usdt).toMatchObject({ entriesMatch: true, verdict: 'OK', difference: '0' });
    expect(Number(usdt.held)).toBeCloseTo(Number(usdt.recorded), 8);
    // Naira is compared in our records only.
    expect(a.body.rows.find((r: { asset: string }) => r.asset === 'ngn')).toMatchObject({ held: null, entriesMatch: true, verdict: 'OK' });

    const b = await call('GET', `/admin/users/${bobId}/balance-check`, { token: ADMIN });
    expect(b.body.rows.find((r: { asset: string }) => r.asset === 'usdt')).toMatchObject({ recorded: '5', held: '5', difference: '0', verdict: 'OK' });
  });

  it('only admins with the right permission; unknown customers are 404', async () => {
    expect((await call('GET', `/admin/users/${aliceId}/balance-check`, { token: alice.token })).status).toBe(401);
    expect((await call('GET', '/admin/users/00000000-0000-4000-8000-000000000000/balance-check', { token: ADMIN })).status).toBe(404);
    expect((await call('GET', '/admin/users/not-an-id/balance-check', { token: ADMIN })).status).toBe(400);
  });
});
