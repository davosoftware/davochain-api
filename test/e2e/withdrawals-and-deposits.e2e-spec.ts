import { call, MONEY, newUser, requireServer, verifyBasic, type TestUser } from './helpers';

let user: TestUser;

beforeAll(async () => {
  await requireServer();
  user = await newUser();
});

describe('crypto withdrawal fee quote (GET /v1/withdrawals/quote)', () => {
  it('prices the network fee and our fee separately', async () => {
    const r = await call('GET', '/withdrawals/quote?asset=btc&amount=0.0002&network=btc', { token: user.token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ asset: 'btc', network: 'btc' });
    for (const f of ['amount', 'networkFee', 'platformFee', 'totalFee', 'totalDeducted', 'youReceive']) expect(r.body[f]).toMatch(MONEY);
  });

  it.each(['', 'abc', '-5', '0', '1e5', '1,000'])('amount %p is 400 "Enter an amount greater than zero", never 500', async (amount) => {
    const r = await call('GET', `/withdrawals/quote?asset=btc&network=btc&amount=${encodeURIComponent(amount)}`, { token: user.token });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Enter an amount greater than zero');
  });

  it('no amount at all is the same 400', async () => {
    const r = await call('GET', '/withdrawals/quote?asset=btc&network=btc', { token: user.token });
    expect(r.status).toBe(400);
  });

  it('no network is 400 "Choose a network"', async () => {
    const r = await call('GET', '/withdrawals/quote?asset=btc&amount=0.0002', { token: user.token });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Choose a network');
  });
});

describe('naira withdrawal fee quote (GET /v1/withdrawals/quote/ngn)', () => {
  it('reports the fee, the limit and whether payouts are available', async () => {
    const r = await call('GET', '/withdrawals/quote/ngn?amount=5000', { token: user.token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ asset: 'ngn', amount: '5000.00', payoutAvailable: expect.any(Boolean), limit: { allowed: expect.any(Boolean) } });
  });

  it.each(['', 'abc', '0'])('amount %p is 400, never 500', async (amount) => {
    const r = await call('GET', `/withdrawals/quote/ngn?amount=${encodeURIComponent(amount)}`, { token: user.token });
    expect(r.status).toBe(400);
  });
});

describe('withdrawals need verification', () => {
  it('a crypto withdrawal by an unverified user is 403', async () => {
    const r = await call('POST', '/withdrawals/crypto', {
      token: user.token,
      body: { amount: '0.0002', savedCryptoAddressId: 'any' },
      headers: { 'Idempotency-Key': 'e2e-' + Date.now() },
    });
    expect(r.status).toBe(403);
    expect(r.body.requiredTier).toBe('TIER_1');
  });
});

describe('deposits', () => {
  let verified: TestUser;
  beforeAll(async () => {
    verified = await verifyBasic(await newUser());
  });

  it('a deposit address is requested and listed', async () => {
    const r = await call('POST', '/deposits/address', { token: verified.token, body: { asset: 'btc', network: 'btc' } });
    expect([200, 201]).toContain(r.status);
    expect(r.body).toMatchObject({ asset: 'btc', network: 'btc', status: expect.any(String), usable: expect.any(Boolean) });
    const list = await call('GET', '/deposits/addresses', { token: verified.token });
    expect((list.body as Array<{ asset: string }>).some((a) => a.asset === 'btc')).toBe(true);
  });

  it('an unknown network is refused, never 500', async () => {
    const r = await call('POST', '/deposits/address', { token: verified.token, body: { asset: 'btc', network: 'not-a-network' } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it('deposit and withdrawal history are lists', async () => {
    expect(Array.isArray((await call('GET', '/deposits', { token: verified.token })).body)).toBe(true);
    expect(Array.isArray((await call('GET', '/withdrawals', { token: verified.token })).body)).toBe(true);
  });

  it('GET /v1/deposits/ngn/account: 404 NO_VIRTUAL_ACCOUNT with a reason for someone not verified', async () => {
    const r = await call('GET', '/deposits/ngn/account', { token: user.token });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'NO_VIRTUAL_ACCOUNT', eligible: false, reason: expect.any(String) });
  });

  it('GET /v1/deposits/ngn/account for a verified customer opens it (or says it is on its way): no BVN needed', async () => {
    const r = await call('GET', '/deposits/ngn/account', { token: verified.token });
    expect([200, 202]).toContain(r.status);
    if (r.status === 200) expect(r.body).toMatchObject({ accountNumber: expect.stringMatching(/^\d{10}$/), status: 'ACTIVE' });
    else expect(r.body).toEqual({ status: 'PENDING', message: expect.any(String) });
  });
});
