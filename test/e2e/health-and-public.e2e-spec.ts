import { call, requireServer } from './helpers';

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
