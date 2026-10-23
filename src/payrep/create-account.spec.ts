import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { classifyOpenAccount } from './payrep.classify';
import { PayrepClient } from './payrep.client';
import { PayrepMock } from './payrep.mock';

/**
 * Opening a customer's naira account WITHOUT their BVN or NIN (spec 2026-10-23):
 * Payrep create_account, named from the customer's ID, pooled into our main account.
 */

const ok = (data: unknown, message = 'ok') => ({ status: true, response_code: '00', message, data });
const no = (code: string, message: string) => ({ status: false, response_code: code, message, data: null });

describe('classifyOpenAccount: a write, so anything unknown is UNCLEAR', () => {
  it('a full answer is ok', () =>
    expect(classifyOpenAccount(200, ok({ account_number: '7356147005', account_name: 'DavoChain-ADA OBI' }))).toEqual({
      ok: true,
      data: { account_number: '7356147005', account_name: 'DavoChain-ADA OBI' },
    }));
  it('42 (pool account wrong), 60 (our business inactive), 41 and 43 are CONFIG: our setup, not the customer', () => {
    expect(classifyOpenAccount(200, no('42', 'Pool account not found, is a virtual account, or is already linked to another pool'))).toMatchObject({ ok: false, kind: 'CONFIG' });
    expect(classifyOpenAccount(200, no('60', 'Customer must be active to create additional accounts'))).toMatchObject({ kind: 'CONFIG' });
    expect(classifyOpenAccount(200, no('43', 'Insufficient permissions'))).toMatchObject({ kind: 'CONFIG' });
  });
  it('83 "Failed to create account in core banking" is UNCLEAR: we look before ever sending again', () => {
    expect(classifyOpenAccount(200, no('83', 'Failed to create account in core banking'))).toMatchObject({ kind: 'UNCLEAR' });
  });
  it('a token refusal is TOKEN; 5xx, unparseable, unknown codes and ok-without-data are UNCLEAR', () => {
    expect(classifyOpenAccount(401, no('42', 'Invalid token'))).toMatchObject({ kind: 'TOKEN' });
    const cases: Array<[number, unknown]> = [[500, undefined], [200, undefined], [200, no('99', 'x')], [200, ok(null)]];
    for (const [h, b] of cases) expect(classifyOpenAccount(h, b)).toMatchObject({ kind: 'UNCLEAR' });
  });
});

// ── the real client against a local HTTP server ─────────────

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
let server: Server;
let base = '';
let handler: Handler;
const seen: Array<{ url: string; body: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url!, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => (seen.length = 0));

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const token = (res: ServerResponse) => json(res, 200, { status: true, response_code: '00', data: { access_token: 'tok1', expires_in: 3600 } });
const isToken = (req: IncomingMessage) => req.url!.endsWith('/generate_token');
const client = () => new PayrepClient({ baseUrl: base, mainAccount: '7801234567', credentials: async () => ({ clientId: 'pk_test_a', clientSecret: 'sk_test_b' }) });
const reply = (body: unknown, status = 200): Handler => (req, res) => (isToken(req) ? token(res) : json(res, status, body));

describe('PayrepClient.createAccount', () => {
  const opened = ok(
    { account_number: '7356147005', account_name: 'DavoChain-ADA CHIOMA OBI', account_type: 'current', status: 'active', bank_name: '', bank_code: '', tier: 5 },
    'Account created successfully',
  );

  it('sends the name, the pool and the prefix switch, never an identity number, and reads the account', async () => {
    handler = reply(opened);
    const a = await client().createAccount({ accountName: 'ADA CHIOMA OBI', poolAccountNumber: '7801234567' });
    const sent = seen.find((s) => s.url.endsWith('/create_account'))!;
    expect(sent.url).toBe('/api/v1/account/api/create_account');
    expect(JSON.parse(sent.body)).toEqual({ account_name: 'ADA CHIOMA OBI', is_pool: true, pool_account_number: '7801234567', is_enabled_business_prefix: true });
    expect(sent.body).not.toMatch(/bvn|nin/i);
    // The sandbox leaves bank_name empty: it defaults to Payrep MFB.
    expect(a).toEqual({ accountNumber: '7356147005', accountName: 'DavoChain-ADA CHIOMA OBI', bankName: 'Payrep MFB', status: 'active', providerRef: null });
  });

  it('42 and 60 are CONFIG; 83 and a lost connection are UNCLEAR', async () => {
    handler = reply(no('42', 'Pool account not found'));
    await expect(client().createAccount({ accountName: 'A B', poolAccountNumber: '7801234567' })).rejects.toMatchObject({ kind: 'CONFIG' });
    handler = reply(no('60', 'Customer must be active to create additional accounts'));
    await expect(client().createAccount({ accountName: 'A B', poolAccountNumber: '7801234567' })).rejects.toMatchObject({ kind: 'CONFIG' });
    handler = reply(no('83', 'Failed to create account in core banking'));
    await expect(client().createAccount({ accountName: 'A B', poolAccountNumber: '7801234567' })).rejects.toMatchObject({ kind: 'UNCLEAR' });
    handler = (req, res) => (isToken(req) ? token(res) : res.destroy());
    await expect(client().createAccount({ accountName: 'A B', poolAccountNumber: '7801234567' })).rejects.toMatchObject({ kind: 'UNCLEAR' });
  });

  it('an ok reply without a 10-digit number is UNCLEAR', async () => {
    handler = reply(ok({ account_name: 'X' }));
    await expect(client().createAccount({ accountName: 'X', poolAccountNumber: '7801234567' })).rejects.toMatchObject({ kind: 'UNCLEAR' });
  });
});

describe('PayrepClient.recentAccounts', () => {
  const item = (n: string, name: string, at: string) => ({ account_number: n, account_name: name, account_class: 'secondary', created_at: at });

  it('pages the newest-first list and stops once it is older than "since"', async () => {
    handler = (req, res, body) => {
      if (isToken(req)) return token(res);
      const b = JSON.parse(body);
      if (!b.cursor_id) {
        return json(res, 200, ok({
          items: [item('3046760427', 'ADA OBI', '2026-10-23T12:08:32.45Z'), item('7356147005', 'ADA OBI', '2026-10-23T12:08:32.18Z')],
          limit: 2, has_next: true, next_cursor: { cursor_created_at: '2026-10-23T12:08:32.18Z', cursor_id: 'c1' },
        }));
      }
      return json(res, 200, ok({
        items: [item('2065601034', 'OLD', '2026-10-23T11:22:34Z'), item('1111111111', 'OLDER', '2026-10-22T09:00:00Z')],
        limit: 2, has_next: true, next_cursor: { cursor_created_at: '2026-10-22T09:00:00Z', cursor_id: 'c2' },
      }));
    };
    const list = await client().recentAccounts({ since: new Date('2026-10-23T12:00:00Z') });
    expect(list).toEqual([
      { accountNumber: '3046760427', accountName: 'ADA OBI', createdAt: new Date('2026-10-23T12:08:32.45Z') },
      { accountNumber: '7356147005', accountName: 'ADA OBI', createdAt: new Date('2026-10-23T12:08:32.18Z') },
    ]);
    const pages = seen.filter((s) => s.url.endsWith('/fetch_account_summaries'));
    expect(pages).toHaveLength(2);
    expect(JSON.parse(pages[1].body)).toMatchObject({ cursor_created_at: '2026-10-23T12:08:32.18Z', cursor_id: 'c1' });
  });

  it('answers null (unreadable), never [], when the list cannot be read', async () => {
    handler = reply(ok({ unexpected: true }));
    expect(await client().recentAccounts({ since: new Date() })).toBeNull();
    handler = reply({}, 500);
    expect(await client().recentAccounts({ since: new Date() })).toBeNull();
  });
});

describe('PayrepMock.createAccount behaves like live', () => {
  it('a new number every call, named with the business prefix, listed newest first', async () => {
    const m = new PayrepMock({ port: 1 });
    const since = new Date(Date.now() - 1000);
    const a = await m.createAccount({ accountName: 'ADA OBI', poolAccountNumber: '7801234567' });
    const b = await m.createAccount({ accountName: 'ADA OBI', poolAccountNumber: '7801234567' });
    expect(a.accountNumber).toMatch(/^\d{10}$/);
    expect(b.accountNumber).not.toBe(a.accountNumber);
    expect(a.accountName).toBe('DavoChain-ADA OBI');
    expect((await m.recentAccounts({ since }))!.map((x) => x.accountNumber)).toEqual([b.accountNumber, a.accountNumber]);
  });

  it('a name containing ANSWER LOST opens the account but answers UNCLEAR (the lost-answer drill)', async () => {
    const m = new PayrepMock({ port: 1 });
    const since = new Date(Date.now() - 1000);
    await expect(m.createAccount({ accountName: 'ANSWER LOST', poolAccountNumber: '7801234567' })).rejects.toMatchObject({ kind: 'UNCLEAR' });
    expect((await m.recentAccounts({ since }))!.map((x) => x.accountName)).toEqual(['DavoChain-ANSWER LOST']);
  });
});
