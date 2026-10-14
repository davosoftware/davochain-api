import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DojahClient } from './dojah.client';
import { DojahError } from './dojah.errors';

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

function client(deadlines = { lookup: 2000, aml: 2000, balance: 2000 }) {
  const cfg = { baseUrl: base, credentials: async () => ({ appId: 'app-1', secretKey: 'sk-1' }) };
  const c = new DojahClient(cfg as never, deadlines);
  (c as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => undefined;
  return c;
}
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('DojahClient', () => {
  it('sends AppId and the raw secret (no Bearer) and normalises a BVN record', async () => {
    handler = (_q, res) => json(res, 200, { entity: { first_name: 'JOHN', last_name: 'AJAYI', date_of_birth: '2000-05-01', gender: 'Male', image: 'x'.repeat(1000) } });
    const r = await client().lookup('BVN', '22222222222');
    expect(r).toMatchObject({ found: true, identity: { firstName: 'JOHN', gender: 'MALE', usable: true } });
    expect(seen[0].url).toBe('/api/v1/kyc/bvn/full?bvn=22222222222');
    expect(seen[0].headers.appid).toBe('app-1');
    expect(seen[0].headers.authorization).toBe('sk-1');
  });

  it('uses /api/v1/kyc/nin for a NIN', async () => {
    handler = (_q, res) => json(res, 200, { entity: { first_name: 'J', last_name: 'A', date_of_birth: '1990-01-01' } });
    await client().lookup('NIN', '70123456789');
    expect(seen[0].url).toBe('/api/v1/kyc/nin?nin=70123456789');
  });

  it('404 is "not found", sent once', async () => {
    handler = (_q, res) => json(res, 404, { error: 'Invalid BVN' });
    expect(await client().lookup('BVN', '11111111111')).toEqual({ found: false, httpStatus: 404 });
    expect(seen).toHaveLength(1);
  });

  it('a lookup is retried on 429 (refused, so not billed), up to 3 sends', async () => {
    handler = (_q, res) => json(res, 429, { error: 'slow down' });
    await expect(client().lookup('BVN', '22222222222')).rejects.toMatchObject({ kind: 'RATE_LIMITED' });
    expect(seen).toHaveLength(3);
  });

  it('a lookup is NEVER retried after a 5xx: a gateway may have billed it (§R1.3)', async () => {
    handler = (_q, res) => json(res, 502, {});
    await expect(client().lookup('BVN', '22222222222')).rejects.toMatchObject({ kind: 'SERVER' });
    expect(seen).toHaveLength(1);
  });

  it('a lookup is NEVER retried after a timeout (UNKNOWN), and the error carries no number', async () => {
    handler = () => undefined; // never answers
    const err = await client({ lookup: 200, aml: 200, balance: 200 }).lookup('BVN', '22222222222').catch((e) => e);
    expect(err).toBeInstanceOf(DojahError);
    expect(err.kind).toBe('UNKNOWN');
    expect(err.message).not.toContain('22222222222');
    expect(seen).toHaveLength(1);
  });

  it('a lookup IS retried when the connection was refused (never sent)', async () => {
    const dead = new DojahClient({ baseUrl: 'http://127.0.0.1:1', credentials: async () => ({ appId: 'a', secretKey: 's' }) } as never, { lookup: 500, aml: 500, balance: 500 });
    const tries: number[] = [];
    (dead as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms) => void tries.push(ms);
    await expect(dead.lookup('BVN', '22222222222')).rejects.toMatchObject({ kind: 'NOT_SENT' });
    expect(tries).toEqual([250, 1000]);
  });

  it('an AML screen is sent exactly once, whatever happens (§R1.3)', async () => {
    for (const status of [429, 500, 502]) {
      seen.length = 0;
      handler = (_q, res) => json(res, status, {});
      await expect(client().screen({ names: 'John Doe Ajayi', date_of_birth: '2000-05-01', nationality: 'NG' }, 'scr-1')).rejects.toBeInstanceOf(DojahError);
      expect(seen).toHaveLength(1);
    }
  });

  it('sends the AML body the spec fixes (§14.3), with no id_number', async () => {
    handler = (_q, res) => json(res, 200, { entity: { entity_id: 'e1', match_status: 'No Match', results: [] } });
    const r = await client().screen({ names: 'John Doe Ajayi', date_of_birth: '2000-05-01', gender: 'Male', nationality: 'NG' }, 'scr-1');
    expect(r.parsed).toMatchObject({ status: 'CLEAR', entityId: 'e1' });
    const sent = JSON.parse(seen[0].body);
    expect(seen[0].url).toBe('/api/v1/aml/v2/screening');
    expect(sent).toEqual({
      schema: 'individual',
      unique_reference: 'scr-1',
      properties: { names: 'John Doe Ajayi', date_of_birth: '2000-05-01', gender: 'Male', nationality: 'NG' },
      screening_options: { pep_check: true, sanction: true, adverse_media_check: true },
    });
    expect(seen[0].body).not.toMatch(/id_number/);
  });

  it('reads the wallet balance as naira, retrying a free call', async () => {
    let n = 0;
    handler = (_q, res) => (++n < 2 ? json(res, 503, {}) : json(res, 200, { entity: { wallet_balance: '12500.50' } }));
    expect(await client().balance()).toBe(12500.5);
    expect(seen).toHaveLength(2);
  });

  it('a balance that is not a number is UNKNOWN, not zero', async () => {
    handler = (_q, res) => json(res, 200, { entity: { wallet_balance: 'n/a' } });
    await expect(client().balance()).rejects.toMatchObject({ kind: 'UNKNOWN' });
  });
});
