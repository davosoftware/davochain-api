import { call, credit, newUser, requireServer, verifyBasic } from './helpers';

beforeAll(requireServer);

describe('health and public routes', () => {
  it('GET /health reports the database up', async () => {
    const r = await call('GET', '/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ok', database: 'up' });
  });

  it('GET /v1/site is public and carries the maintenance switch', async () => {
    const r = await call('GET', '/site');
    expect(r.status).toBe(200);
    expect(typeof r.body.maintenance.active).toBe('boolean');
    expect(['string', 'object']).toContain(typeof r.body.maintenance.message); // a string, or null
  });

  it('GET /v1/kyc/states lists the 36 states plus the FCT, with 774 LGAs', async () => {
    const r = await call('GET', '/kyc/states');
    expect(r.status).toBe(200);
    const states = r.body.states as Array<{ name: string; lgas: string[] }>;
    expect(states).toHaveLength(37);
    expect(states.reduce((n, s) => n + s.lgas.length, 0)).toBe(774);
    expect(states.find((s) => s.name === 'Lagos')?.lgas).toContain('Ikeja');
    expect(states.map((s) => s.name)).toContain('FCT');
  });

  it('GET /v1/rates is public: every listed coin with its naira buy and sell price', async () => {
    const r = await call('GET', '/rates');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ refreshSeconds: 30, referenceUsd: '100' });
    const listed = await call('GET', '/assets');
    expect((r.body.coins as Array<{ code: string }>).map((c) => c.code)).toEqual(
      (listed.body as Array<{ code: string }>).map((a) => a.code),
    );
    const priced = (r.body.coins as Array<{ available: boolean; buy: { ngnPerUsd: string; ngnPerUnit: string }; sell: { ngnPerUsd: string } }>).filter((c) => c.available);
    expect(priced.length).toBeGreaterThan(0);
    for (const c of priced) {
      expect(c.buy.ngnPerUnit).toMatch(/^\d+\.\d{2}$/);
      // We always charge more to buy than we pay to sell.
      expect(Number(c.buy.ngnPerUsd)).toBeGreaterThan(Number(c.sell.ngnPerUsd));
    }
  });

  it('GET /v1/rates matches what a buy quote charges for the same size', async () => {
    const user = await verifyBasic(await newUser());
    credit(user, 'ngn', '1000000');
    const board = await call('GET', '/rates');
    const usdt = (board.body.coins as Array<{ code: string; available: boolean; buy: { ngnPerUsd: string } }>).find((c) => c.code === 'usdt');
    if (!usdt?.available) return; // no usdt price in this environment
    // ~$100 of USDT at the board's rate: the same margin band as the board.
    const ngn = (Number(usdt.buy.ngnPerUsd) * 100).toFixed(2);
    const q = await call('POST', '/quotes', { token: user.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'usdt', amount: ngn } });
    expect(q.status).toBe(201);
    // The quote may be a few seconds fresher than the shared board, so allow 1%.
    expect(Math.abs(Number(q.body.rate) - Number(usdt.buy.ngnPerUsd)) / Number(usdt.buy.ngnPerUsd)).toBeLessThan(0.01);
  });

  it('a protected route without a token is 401 "Missing bearer token"', async () => {
    const r = await call('GET', '/me');
    expect(r.status).toBe(401);
    expect(r.body.message).toBe('Missing bearer token');
  });

  it('a garbage token is 401 "Invalid or expired token"', async () => {
    const r = await call('GET', '/me', { token: 'not-a-real-token' });
    expect(r.status).toBe(401);
    expect(r.body.message).toBe('Invalid or expired token');
  });

  it('the removed tier1 route and unknown routes answer 404', async () => {
    expect((await call('POST', '/kyc/tier1', { body: {} })).status).toBe(404);
    expect((await call('GET', '/this-route-does-not-exist')).status).toBe(404);
  });
});
