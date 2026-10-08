import http from 'node:http';
import { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { FlutterwaveClient } from './flutterwave.client';
import { FlutterwaveError, FlutterwaveUnknownError } from './flutterwave.errors';

type Reply = { status: number; body?: string; delayMs?: number };
const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
const ok = (data: unknown, meta?: unknown) => ({
  status: 200,
  body: JSON.stringify({ status: 'success', message: 'ok', data, ...(meta ? { meta } : {}) }),
});
const BVN = '22222223883';

/** The real client against a local fake of Flutterwave's v3 API. */
describe('FlutterwaveClient', () => {
  let server: http.Server;
  let base: string;
  const replies: Reply[] = [];
  const seen: Array<{ method: string; url: string; auth?: string; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body });
        const reply = replies.shift() ?? { status: 500, body: '{"status":"error","message":"no reply queued"}' };
        const send = () => {
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(reply.body ?? '');
        };
        if (reply.delayMs) setTimeout(send, reply.delayMs);
        else send();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    replies.length = 0;
    seen.length = 0;
  });

  function client(opts: { backoffMs?: number[]; timeoutMs?: number } = {}) {
    const cfg = { baseUrl: base, rateLimitPerMinute: 100_000, secretKey: async () => 'FLWSECK_TEST-unit-X' };
    return new FlutterwaveClient(cfg as never, {
      backoffMs: opts.backoffMs ?? [0, 0, 0],
      timeoutMs: opts.timeoutMs ?? 2_000,
    });
  }

  it('verifies a payment, authenticates, and keeps every amount as exact text', async () => {
    replies.push({ status: 200, body: fixture('verify-bank-transfer.json') });
    const tx = await client().verifyTransaction('10535993');
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/transactions/10535993/verify', auth: 'Bearer FLWSECK_TEST-unit-X' });
    expect(tx).toMatchObject({
      id: '10535993',
      amount: '1500',
      charged_amount: '1500',
      app_fee: '21',
      amount_settled: '1479',
      status: 'successful',
      payment_type: 'bank_transfer',
    });
    expect(tx.meta).toMatchObject({ virtualaccountnumber: '0067100155', originatorname: 'JOHN DOE' });
  });

  it('never rounds a fractional fee', async () => {
    replies.push({ status: 200, body: '{"status":"success","data":{"id":7,"amount":2000.50,"app_fee":26.875}}' });
    const tx = await client().verifyTransaction('7');
    expect(tx.amount).toBe('2000.50');
    expect(tx.app_fee).toBe('26.875');
  });

  it('retries a read after an unknown answer and returns the success', async () => {
    replies.push(
      { status: 503, body: '{"status":"error","message":"An error occurred"}' },
      ok({ currency: 'NGN', available_balance: 10, ledger_balance: 12 }),
    );
    const bal = await client().getBalance('NGN');
    expect(bal).toEqual({ currency: 'NGN', available_balance: '10', ledger_balance: '12' });
    expect(seen).toHaveLength(2);
  });

  it('gives up on a read after four unknown answers', async () => {
    for (let i = 0; i < 4; i++) replies.push({ status: 503, body: '{"status":"error"}' });
    await expect(client().getBalance('NGN')).rejects.toBeInstanceOf(FlutterwaveUnknownError);
    expect(seen).toHaveLength(4);
  });

  it('retries a read after a rate limit', async () => {
    replies.push(
      { status: 429, body: '{"status":"error","message":"slow down"}' },
      ok({ currency: 'NGN', available_balance: 1, ledger_balance: 1 }),
    );
    await expect(client().getBalance('NGN')).resolves.toMatchObject({ currency: 'NGN' });
    expect(seen).toHaveLength(2);
  });

  it('sends a write exactly once, even when the answer is unknown', async () => {
    replies.push({ status: 503, body: '{"status":"error"}' }, ok({}));
    const err = await client()
      .createStaticVirtualAccount({ email: 'a@b.c', txRef: 'dcva_x', firstName: 'Ada', lastName: 'Obi', narration: 'Ada Obi', bvn: BVN })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlutterwaveUnknownError);
    expect(seen).toHaveLength(1);
  });

  it('creates a permanent NGN account at Flutterwave MFB with exactly one identity number', async () => {
    replies.push(ok({ order_ref: 'URF_1', account_number: '0067100155', account_status: 'active', bank_name: 'Mock Bank', flw_ref: 'F1' }));
    const account = await client().createStaticVirtualAccount({
      email: 'ada@example.com',
      txRef: 'dcva_7f3c2a1b9e8d4c6fa1b2c3d4e5f60718',
      firstName: 'Ada',
      lastName: 'Obi',
      narration: 'Ada Obi',
      bvn: BVN,
    });
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/virtual-account-numbers');
    expect(JSON.parse(seen[0].body)).toEqual({
      email: 'ada@example.com',
      is_permanent: true,
      tx_ref: 'dcva_7f3c2a1b9e8d4c6fa1b2c3d4e5f60718',
      firstname: 'Ada',
      lastname: 'Obi',
      narration: 'Ada Obi',
      currency: 'NGN',
      bank_code: '090567',
      bvn: BVN,
    });
    expect(account.order_ref).toBe('URF_1');
  });

  it('refuses to send both a BVN and a NIN, or neither', async () => {
    const c = client();
    const input = { email: 'a@b.c', txRef: 't', firstName: 'A', lastName: 'B', narration: 'A B' };
    await expect(c.createStaticVirtualAccount({ ...input })).rejects.toThrow(/Exactly one of bvn or nin/);
    await expect(c.createStaticVirtualAccount({ ...input, bvn: BVN, nin: BVN })).rejects.toThrow(/Exactly one of bvn or nin/);
    expect(seen).toHaveLength(0);
  });

  it('turns a 400 with a string detail into a DEFINITE error carrying the detail', async () => {
    replies.push({ status: 400, body: '{"status":"error","message":"Some error occured","data":"Error: Insufficient Wallet Balance"}' });
    const err = (await client().getBalance('NGN').catch((e: unknown) => e)) as FlutterwaveError;
    expect(err).toBeInstanceOf(FlutterwaveError);
    expect(err.kind).toBe('DEFINITE');
    expect(err.detail).toBe('Error: Insufficient Wallet Balance');
  });

  it('flags IP-whitelist and auth problems as CONFIG, and does not retry them', async () => {
    replies.push({ status: 400, body: '{"status":"error","message":"Please enable IP Whitelisting to access this service"}' });
    expect(((await client().getBalance('NGN').catch((e: unknown) => e)) as FlutterwaveError).kind).toBe('CONFIG');
    replies.push({ status: 401, body: '{"status":"error","message":"Authorization required"}' });
    expect(((await client().getBalance('NGN').catch((e: unknown) => e)) as FlutterwaveError).kind).toBe('CONFIG');
    expect(seen).toHaveLength(2);
  });

  it('treats "not found" answers as NOT_FOUND', async () => {
    replies.push({ status: 404, body: '{"status":"error","message":"Transfer not found"}' });
    expect(((await client().getBalance('NGN').catch((e: unknown) => e)) as FlutterwaveError).kind).toBe('NOT_FOUND');
    replies.push({ status: 400, body: '{"status":"error","message":"No transaction was found for this id"}' });
    expect(((await client().verifyTransaction('1').catch((e: unknown) => e)) as FlutterwaveError).kind).toBe('NOT_FOUND');
  });

  it('treats a body that is not JSON, or a success without "success", as UNKNOWN', async () => {
    replies.push({ status: 502, body: '<html>Bad gateway</html>' });
    await expect(client({ backoffMs: [] }).getBalance('NGN')).rejects.toBeInstanceOf(FlutterwaveUnknownError);
    replies.push({ status: 200, body: '<html>ok?</html>' });
    await expect(client({ backoffMs: [] }).getBalance('NGN')).rejects.toBeInstanceOf(FlutterwaveUnknownError);
    replies.push({ status: 200, body: '{"status":"error","message":"odd"}' });
    await expect(client({ backoffMs: [] }).getBalance('NGN')).rejects.toBeInstanceOf(FlutterwaveUnknownError);
  });

  it('treats a timeout as UNKNOWN', async () => {
    replies.push({ status: 200, body: '{"status":"success","data":{}}', delayMs: 400 });
    await expect(client({ backoffMs: [], timeoutMs: 100 }).getBalance('NGN')).rejects.toBeInstanceOf(FlutterwaveUnknownError);
  });

  it('refuses ids and order refs that could reshape the URL, before sending anything', async () => {
    await expect(client().verifyTransaction('1/../../balances')).rejects.toMatchObject({ kind: 'DEFINITE' });
    await expect(client().getVirtualAccount('URF/../x')).rejects.toMatchObject({ kind: 'DEFINITE' });
    expect(seen).toHaveLength(0);
  });

  it('lists transactions with the filters and reads total_pages', async () => {
    replies.push(
      ok(
        [{ id: 989226, tx_ref: 'dcva_x', amount: 1000, status: 'successful', payment_type: 'bank_transfer' }],
        { page_info: { total: 44, current_page: 1, total_pages: 5 } },
      ),
    );
    const page = await client().listTransactions({ from: '2026-10-05', to: '2026-10-08', page: 1, status: 'successful', currency: 'NGN' });
    expect(seen[0].url).toBe('/transactions?from=2026-10-05&to=2026-10-08&page=1&status=successful&currency=NGN');
    expect(page.totalPages).toBe(5);
    expect(page.items[0]).toMatchObject({ id: '989226', amount: '1000' });
  });

  it('never writes a BVN to a log line or an error, even when Flutterwave echoes it', async () => {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug'] as const).map((m) =>
      jest.spyOn(Logger.prototype, m).mockImplementation((...args: unknown[]) => {
        lines.push(JSON.stringify(args));
      }),
    );
    try {
      replies.push({ status: 400, body: JSON.stringify({ status: 'error', message: `BVN ${BVN} could not be validated`, data: `bvn ${BVN}` }) });
      const err = (await client()
        .createStaticVirtualAccount({ email: 'a@b.c', txRef: 't', firstName: 'A', lastName: 'B', narration: 'A B', bvn: BVN })
        .catch((e: unknown) => e)) as FlutterwaveError;
      expect(err.kind).toBe('DEFINITE');
      expect(JSON.stringify({ m: err.message, d: err.detail })).not.toContain(BVN);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join('\n')).not.toContain(BVN);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
