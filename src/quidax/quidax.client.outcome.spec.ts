import http from 'node:http';
import { AddressInfo } from 'node:net';
import { QuidaxClient } from './quidax.client';
import { QuidaxError, QuidaxUnknownError } from './quidax.errors';

/**
 * C4 (PROJECT_REVIEW): a write that gets a server error or a gateway page back
 * may already have been carried out. It must come back as "unknown" (funds stay
 * locked, the reconciler checks), never as "failed" (which refunds). Only a
 * real business rejection is a definite failure.
 *
 * Proved against the real client over a local fake of the API, replaying the
 * answers a load balancer or Quidax itself can give.
 */
describe('QuidaxClient: what a write outcome means', () => {
  let server: http.Server;
  let base: string;
  let reply: { status: number; type: string; body: string } = { status: 200, type: 'application/json', body: '{}' };

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(reply.status, { 'content-type': reply.type });
      res.end(reply.body);
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
  const transfer = () =>
    client().internalTransfer('sub-1', { currency: 'btc', amount: '0.01', fund_uid: 'main', reference: 'dvc_xfer_1' });
  const html = (status: number) => ({ status, type: 'text/html', body: `<html><body>${status} Bad Gateway</body></html>` });
  const envelope = (status: number, message: string) => ({
    status,
    type: 'application/json',
    body: JSON.stringify({ status: 'error', message, data: { code: 'E1', message } }),
  });

  it.each([
    ['a 502 HTML page from a gateway', html(502)],
    ['a 504 HTML page (gateway timeout)', html(504)],
    ['a 500 with an error envelope', envelope(500, 'Something went wrong')],
    ['a 503 with an error envelope', envelope(503, 'Service unavailable')],
    ['a 408 request timeout', envelope(408, 'Request timeout')],
  ])('%s on a write is UNKNOWN, not failed', async (_name, r) => {
    reply = r;
    await expect(transfer()).rejects.toBeInstanceOf(QuidaxUnknownError);
  });

  it.each([
    ['a 422 business rejection', envelope(422, 'Insufficient balance')],
    ['a 400 business rejection', envelope(400, 'Invalid amount')],
    ['a 200 with status "error"', envelope(200, 'Amount below minimum')],
  ])('%s on a write is a definite failure', async (_name, r) => {
    reply = r;
    const err = await transfer().catch((e) => e);
    expect(err).toBeInstanceOf(QuidaxError);
    expect(err).not.toBeInstanceOf(QuidaxUnknownError);
  });
});
