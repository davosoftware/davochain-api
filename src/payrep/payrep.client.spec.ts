import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PayrepClient } from './payrep.client';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server;
let base = '';
let handler: Handler;
const seen: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
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
const token = (res: ServerResponse, n = 1) => json(res, 200, { status: true, response_code: '00', data: { access_token: `tok${n}`, expires_in: 3600 } });
const isToken = (req: IncomingMessage) => req.url!.endsWith('/generate_token');
const client = (opts: { timeoutMs?: number } = {}) =>
  new PayrepClient({ baseUrl: base, mainAccount: '7801234567', credentials: async () => ({ clientId: 'pk_test_a', clientSecret: 'sk_test_b' }) }, opts);

describe('PayrepClient', () => {
  it('gets a token once and reuses it; Bearer on every call', async () => {
    let tokens = 0;
    handler = (req, res) => (isToken(req) ? token(res, ++tokens) : json(res, 200, { status: true, response_code: '00', data: [] }));
    const c = client();
    await c.banks();
    await c.banks();
    expect(tokens).toBe(1);
    expect(seen.filter((s) => s.url.endsWith('/fetch_banks')).every((s) => s.headers.authorization === 'Bearer tok1')).toBe(true);
    expect(seen[0].url).toBe('/api/v1/security/api/generate_token');
    expect(JSON.parse(seen[0].body)).toEqual({ client_id: 'pk_test_a', client_secret: 'sk_test_b' });
  });

  it('two calls at once share one token request', async () => {
    let tokens = 0;
    handler = (req, res) => (isToken(req) ? setTimeout(() => token(res, ++tokens), 50) : json(res, 200, { status: true, response_code: '00', data: [] }));
    const c = client();
    await Promise.all([c.banks(), c.banks()]);
    expect(tokens).toBe(1);
  });

  it('a 401 refreshes the token and resends once', async () => {
    let tokens = 0;
    let banks = 0;
    handler = (req, res) => {
      if (isToken(req)) return token(res, ++tokens);
      banks++;
      return banks === 1 ? json(res, 401, { message: 'expired' }) : json(res, 200, { status: true, response_code: '00', data: [] });
    };
    await client().banks();
    expect({ tokens, banks }).toEqual({ tokens: 2, banks: 2 });
  });

  it('banks maps the NIP code, name and CBN code', async () => {
    handler = (req, res) => (isToken(req) ? token(res) : json(res, 200, { status: true, response_code: '00', data: [{ name: 'Access Bank', code: '000014', cbn_code: '044' }, { junk: 1 }] }));
    expect(await client().banks()).toEqual([{ name: 'Access Bank', code: '000014', cbnCode: '044' }]);
  });

  it('name enquiry sends our main account as the source', async () => {
    handler = (req, res) =>
      isToken(req)
        ? token(res)
        : json(res, 200, { status: true, response_code: '00', data: { beneficiary_account_name: 'JANE DOE', bank_code: '000013', bank_name: 'GTBank', transfer_type: 'inter', session_id: 's1' } });
    expect(await client().nameEnquiry({ accountNumber: '0123456789', bankCode: '000013' })).toEqual({
      accountNumber: '0123456789',
      accountName: 'JANE DOE',
      bankCode: '000013',
      bankName: 'GTBank',
      transferType: 'inter',
      sessionId: 's1',
    });
    expect(JSON.parse(seen[1].body)).toEqual({ beneficiary_account_number: '0123456789', bank_code: '000013', source_account_number: '7801234567' });
  });

  it('a transfer is sent once even on a timeout (UNCLEAR), with the documented body', async () => {
    handler = (req, res) => (isToken(req) ? token(res) : undefined); // never answers the transfer
    const r = await client({ timeoutMs: 200 }).transfer({
      reference: 'dvc_ngnwd_1',
      sourceAccountNumber: '7801234567',
      sourceAccountName: 'DAVOCHAIN',
      beneficiaryAccountNumber: '0123456789',
      beneficiaryAccountName: 'JANE DOE',
      bankCode: '000013',
      bankName: 'GTBank',
      amount: '25000.00',
      transferType: 'inter',
      remarks: 'DavoChain payout',
      sessionId: 's1',
    });
    expect(r.kind).toBe('UNCLEAR');
    const sent = seen.filter((s) => s.url === '/api/v1/transaction/transfer/api/funds_transfer');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body)).toEqual({
      source_account_number: '7801234567',
      source_account_name: 'DAVOCHAIN',
      beneficiary_account_number: '0123456789',
      beneficiary_account_name: 'JANE DOE',
      bank_code: '000013',
      bank_name: 'GTBank',
      amount: '25000.00',
      transfer_type: 'inter',
      reference_number: 'dvc_ngnwd_1',
      remarks: 'DavoChain payout',
      session_id: 's1',
    });
  });

  it('a transfer answered 503 is UNCLEAR and not resent', async () => {
    handler = (req, res) => (isToken(req) ? token(res) : json(res, 503, { message: 'down' }));
    const r = await client().transfer({
      reference: 'r', sourceAccountNumber: '1', sourceAccountName: 'X', beneficiaryAccountNumber: '2', beneficiaryAccountName: 'Y',
      bankCode: '000013', bankName: 'B', amount: '1.00', transferType: 'inter', remarks: 'r', sessionId: null,
    });
    expect(r.kind).toBe('UNCLEAR');
    expect(seen.filter((s) => s.url.endsWith('/funds_transfer'))).toHaveLength(1);
  });

  it('transactionStatus posts the reference and classifies the answer', async () => {
    handler = (req, res) => (isToken(req) ? token(res) : json(res, 200, { status: false, response_code: '80', message: 'Transaction not found.', data: null }));
    expect(await client().transactionStatus('trsy_1')).toEqual({ kind: 'NOT_FOUND' });
    expect(JSON.parse(seen[1].body)).toEqual({ reference_number: 'trsy_1' });
  });

  it('reads throw typed errors: CONFIG on 41, REFUSED on 06, UNCLEAR on 5xx', async () => {
    const cases: Array<[string, number, string]> = [['41', 200, 'CONFIG'], ['06', 200, 'REFUSED'], ['', 503, 'UNCLEAR']];
    for (const [code, http, kind] of cases) {
      handler = (req, res) => (isToken(req) ? token(res) : json(res, http, code ? { status: false, response_code: code, message: 'm', data: null } : { message: 'down' }));
      await expect(client().nameEnquiry({ accountNumber: '0123456789', bankCode: '000013' })).rejects.toMatchObject({ kind });
    }
  });

  it('refused keys are CONFIG', async () => {
    handler = (_req, res) => json(res, 200, { status: false, response_code: '41', message: 'Unauthorized - invalid API credentials', data: null });
    await expect(client().banks()).rejects.toMatchObject({ kind: 'CONFIG' });
  });

  it('fetchCredits sends the documented filters and reads any list shape', async () => {
    handler = (req, res) =>
      isToken(req)
        ? token(res)
        : json(res, 200, { status: true, response_code: '00', data: { results: [{ transaction_id: 't1', amount: '5.00', status: 'success', account_number: '2012345678' }] } });
    const r = await client().fetchCredits({ accountNumber: '2012345678', startDate: '2026-10-20', endDate: '2026-10-22' });
    expect(r.items).toEqual([expect.objectContaining({ transactionId: 't1', amount: '5.00' })]);
    expect(r.next).toBeNull();
    expect(JSON.parse(seen[1].body)).toEqual({
      filters: { transaction_type: 'credit', start_date: '2026-10-20', end_date: '2026-10-22', account_number: '2012345678' },
      limit: 50,
      page_size: 50,
    });
  });

  it('an unreadable list is UNCLEAR, never "nothing there" (final review I2)', async () => {
    handler = (req, res) => (isToken(req) ? token(res) : json(res, 200, { status: true, response_code: '00', data: { records: [{ transaction_id: 't1' }] } }));
    await expect(client().fetchCredits({ startDate: '2026-10-20', endDate: '2026-10-22' })).rejects.toMatchObject({ kind: 'UNCLEAR' });
    handler = (req, res) => (isToken(req) ? token(res) : json(res, 200, { status: true, response_code: '00', data: 'oops' }));
    await expect(client().banks()).rejects.toMatchObject({ kind: 'UNCLEAR' });
  });

  it("follows Payrep's next_cursor when it sends one, even on a short page", async () => {
    handler = (req, res) =>
      isToken(req)
        ? token(res)
        : json(res, 200, {
            status: true,
            response_code: '00',
            data: { results: [{ transaction_id: 't1', amount: '5.00', created_at: '2026-10-21T10:00:00Z' }], next_cursor: { cursor_created_at: '2026-10-21T10:00:00Z', cursor_id: 't1' } },
          });
    const r = await client().fetchCredits({ startDate: '2026-10-20', endDate: '2026-10-22' });
    expect(r.next).toEqual({ createdAt: '2026-10-21T10:00:00Z', id: 't1' });
  });

  it('never logs a body, an identity number, a key or a token', async () => {
    const logs: string[] = [];
    handler = (req, res) => (isToken(req) ? token(res) : json(res, 200, { status: true, response_code: '00', data: { account_number: '2070174481' } }));
    const c = client();
    (c as unknown as { log: { log: (m: string) => void; warn: (m: string) => void } }).log = { log: (m) => logs.push(m), warn: (m) => logs.push(m) };
    await c.createCustomerAccount({ bvn: '22222222222', poolAccountNumber: '7801234567' });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join(' ')).not.toMatch(/22222222222|sk_test_b|tok1/);
  });
});
