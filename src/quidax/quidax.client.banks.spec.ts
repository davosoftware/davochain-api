import http from 'node:http';
import { AddressInfo } from 'node:net';
import { QuidaxClient } from './quidax.client';

/**
 * GET /banks is a list endpoint, and Quidax pages every list (50 by default,
 * `x-next-page` for the next one). Nigeria has far more than 50 banks, so a
 * single page hides most of them from the bank picker. Proved against the real
 * client over a local fake of the paged API.
 */
describe('QuidaxClient.fetchBanks', () => {
  let server: http.Server;
  let base: string;
  const seen: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.url ?? '');
      const page = new URL(req.url ?? '/', 'http://local').searchParams.get('page') ?? '1';
      const banks =
        page === '1'
          ? [{ code: '044', name: 'Access Bank', country: 'Nigeria', currency: 'NGN' }]
          : [{ code: '058', name: 'GTBank', country: 'Nigeria', currency: 'NGN' }];
      res.writeHead(200, {
        'content-type': 'application/json',
        ...(page === '1' ? { 'x-next-page': '2' } : {}),
      });
      res.end(JSON.stringify({ status: 'success', message: 'ok', data: banks }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function client(): QuidaxClient {
    const config = {
      getOrThrow: () => base,
      get: (k: string) => (k === 'QUIDAX_SECRET_KEY' ? 'test-key' : undefined),
    };
    return new QuidaxClient(config as never, { get: async () => undefined } as never);
  }

  it('reads every page of the bank list', async () => {
    const banks = await client().fetchBanks();
    expect(banks.map((b) => b.code)).toEqual(['044', '058']);
    expect(seen.some((url) => url.includes('page=2'))).toBe(true);
  });

  it('asks for the largest page Quidax allows', async () => {
    seen.length = 0;
    await client().fetchBanks();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((url) => url.includes('per_page=100'))).toBe(true);
  });
});
