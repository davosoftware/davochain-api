import http from 'node:http';
import { AddressInfo } from 'node:net';
import { QuidaxClient, LANE_MAX_WAIT_MS } from './quidax.client';
import { QuidaxRateLimitError } from './quidax.errors';

/**
 * M9: when the Quidax budget is used up, a call that would wait longer than
 * its lane allows fails at once as "busy", and nothing reaches Quidax, so it
 * is safe to treat as "nothing happened" (QuidaxRateLimitError).
 */
describe('QuidaxClient: a busy lane', () => {
  let server: http.Server;
  let base: string;
  let hits = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      hits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', message: 'ok', data: { id: 'u1' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // One call a minute: the second must wait ~60 s, over the default lane's allowance.
  const client = () =>
    new QuidaxClient(
      {
        getOrThrow: () => base,
        get: (k: string) => ({ QUIDAX_SECRET_KEY: 'test-key', QUIDAX_RATE_LIMIT_PER_MINUTE: 1 } as Record<string, unknown>)[k],
      } as never,
      { get: async () => undefined } as never,
    );

  it('refuses as busy instead of waiting a minute, and sends nothing', async () => {
    const c = client();
    await c.fetchSubAccount('u1');
    hits = 0;
    const started = Date.now();
    const err = await c.fetchSubAccount('u1').catch((e) => e);
    expect(err).toBeInstanceOf(QuidaxRateLimitError);
    expect(err.retryAfterMs).toBeGreaterThan(LANE_MAX_WAIT_MS.default);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(hits).toBe(0);
  });

  it('each lane has a time limit: short for people waiting on a screen, longer for background work', () => {
    expect(LANE_MAX_WAIT_MS).toEqual({ default: 10_000, address: 10_000, background: 120_000 });
  });
});
