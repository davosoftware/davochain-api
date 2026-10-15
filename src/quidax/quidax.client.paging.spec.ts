import http from 'node:http';
import { AddressInfo } from 'node:net';
import { QuidaxClient } from './quidax.client';

/**
 * M9 (PROJECT_REVIEW):
 *  - the 30-minute deposit gap sweep read ONE page of /users/deposits/all, so a
 *    deposit beyond it was never recovered;
 *  - creating a customer's sub-account ran on the trading lane, so a burst of
 *    sign-ups queued in front of real trades.
 */
describe('QuidaxClient: deposits list and sub-account lane (M9)', () => {
  let server: http.Server;
  let base: string;
  const seen: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const page = new URL(req.url ?? '/', 'http://local').searchParams.get('page') ?? '1';
      if (req.url?.startsWith('/users/deposits/all')) {
        res.writeHead(200, { 'content-type': 'application/json', ...(page === '1' ? { 'x-next-page': '2' } : {}) });
        res.end(JSON.stringify({ status: 'success', message: 'ok', data: [{ id: `dep-p${page}` }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', message: 'ok', data: { id: 'sub-1' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const client = () =>
    new QuidaxClient(
      { getOrThrow: () => base, get: (k: string) => (k === 'QUIDAX_SECRET_KEY' ? 'test-key' : undefined) } as never,
      { get: async () => undefined } as never,
    );

  it('the deposit gap sweep reads every page', async () => {
    const deposits = await client().fetchAllSubUserDeposits({ start_date: '2026-10-14' });
    expect(deposits.map((d) => d.id)).toEqual(['dep-p1', 'dep-p2']);
    expect(seen.some((u) => u.includes('/users/deposits/all') && u.includes('start_date=2026-10-14'))).toBe(true);
  });

  it('creating a sub-account runs on the background lane, not the trading lane', async () => {
    const c = client();
    const lanes = (c as unknown as { lanes: Record<string, { take: () => Promise<void> }> }).lanes;
    const taken: string[] = [];
    for (const [name, bucket] of Object.entries(lanes)) {
      const original = bucket.take.bind(bucket);
      bucket.take = async () => (taken.push(name), original());
    }
    await c.createSubAccount({ email: 'a@x.test', first_name: 'A', last_name: 'B' });
    expect(taken).toEqual(['background']);
  });
});
