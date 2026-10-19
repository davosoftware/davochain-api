import { API, adminToken, call, hasAdmin, newUser, requireServer, verifyBasic, type TestUser } from './helpers';

/**
 * File storage (H8, 19 Oct 2026), over real HTTP against `npm run start:e2e`,
 * which uses the IN-MEMORY store: nothing here touches the real R2 bucket.
 *
 *  - ID documents: a real multipart upload, retries, bad files, the old format.
 *  - Admins: storage status, opening a document (headers, audit log).
 *  - Gift cards: a sale with photos bigger than the old 1 MB request limit,
 *    a retry, reading a photo back, and an anonymous large request.
 *
 * Admin parts need E2E_ADMIN_*. Everything changed is put back in afterAll.
 */
const describeAdmin = hasAdmin ? describe : describe.skip;

/** A "PNG": the real 8-byte signature, then filler. The server reads only the start to decide the type. */
const png = (bytes: number, seed = 'a') =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes - 8, seed)]);

async function upload(token: string, type: string, file: Buffer, name = 'doc.png') {
  const form = new FormData();
  form.append('type', type);
  form.append('file', new Blob([new Uint8Array(file)], { type: 'image/png' }), name);
  const res = await fetch(`${API}/kyc/documents`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let user: TestUser;
let ADMIN: string;

beforeAll(async () => {
  await requireServer();
  user = await verifyBasic(await newUser());
  if (hasAdmin) ADMIN = (await adminToken())!;
});

describe('ID document upload (H8)', () => {
  let firstId: string;
  const photo = png(200_000, 'p');

  it('stores a real upload and answers 201 with the new document', async () => {
    const r = await upload(user.token, 'PASSPORT', photo);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ type: 'PASSPORT', status: 'PENDING' });
    expect(r.body).not.toHaveProperty('storageKey');
    firstId = r.body.id;
  });

  it('the same file again (a retry) answers 200 with the SAME document', async () => {
    const r = await upload(user.token, 'PASSPORT', photo);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(firstId);
  });

  it('refuses a file that is not really a photo or PDF, whatever its name says', async () => {
    const r = await upload(user.token, 'PASSPORT', Buffer.from('<html><script>alert(1)</script></html>'), 'passport.png');
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/JPEG, PNG or WebP photo, or a PDF/);
  });

  it('refuses BVN as a document type', async () => {
    expect((await upload(user.token, 'BVN', png(1000))).status).toBe(400);
  });

  it('refuses a file over 10 MB with 413', async () => {
    const r = await upload(user.token, 'SELFIE', png(10 * 1024 * 1024 + 1, 'b'));
    expect(r.status).toBe(413);
    expect(r.body.message).toBe('Each document must be 10 MB or smaller');
  });

  it('refuses the old JSON format that named its own storage location', async () => {
    const r = await call('POST', '/kyc/documents', { token: user.token, body: { type: 'PASSPORT', storageKey: 'kyc/someone-else/x', mimeType: 'image/png', sizeBytes: 10 } });
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/multipart\/form-data/);
  });

  it('needs a signed-in customer', async () => {
    const form = new FormData();
    form.append('type', 'PASSPORT');
    form.append('file', new Blob([new Uint8Array(png(1000))]), 'p.png');
    const res = await fetch(`${API}/kyc/documents`, { method: 'POST', body: form });
    expect(res.status).toBe(401);
  });

  describeAdmin('admins', () => {
    it('storage status: the in-memory test store, answering', async () => {
      const r = await call('GET', '/admin/storage/status', { token: ADMIN });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ driver: 'memory', reachable: true, bucket: null });
    });

    it('opening a document gives back the exact file, uncacheable and sandboxed, and records who opened it', async () => {
      const res = await fetch(`${API}/admin/kyc/documents/${firstId}/file`, { headers: { authorization: `Bearer ${ADMIN}` } });
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(photo)).toBe(true);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");

      const audit = await call('GET', '/admin/audit?action=kyc.document.view', { token: ADMIN });
      expect(audit.status).toBe(200);
      expect(JSON.stringify(audit.body)).toContain(firstId);
    });

    it('a customer token cannot open documents', async () => {
      const res = await fetch(`${API}/admin/kyc/documents/${firstId}/file`, { headers: { authorization: `Bearer ${user.token}` } });
      expect(res.status).toBe(401);
    });
  });
});

describeAdmin('Gift-card sale with photos over the old 1 MB limit (H8)', () => {
  type Rule = { level: string; action: string; allowed: boolean; currency: string; minPerTx: string | null; maxPerTx: string | null; maxPerDay: string | null };
  let levels: { rules: Rule[]; cooloffs: unknown[]; platform: unknown };
  let category: string, brand: string, type: string;
  const stamp = Date.now().toString(36);
  // Two 1.5 MB photos: about 4 MB of JSON, which the old 1 MB limit refused.
  const photos = [png(1_500_000, 'x'), png(1_500_000, 'y')];
  const sale = () => ({ typeId: type, faceValue: '50', images: photos.map((p) => `data:image/png;base64,${p.toString('base64')}`) });
  let tradeId: string;

  beforeAll(async () => {
    const lv = await call('GET', '/admin/levels', { token: ADMIN });
    expect(lv.status).toBe(200);
    levels = lv.body;
    const rules = levels.rules.map((r) =>
      r.action === 'GIFTCARD_SELL' && r.level === 'BASIC' ? { ...r, allowed: true, minPerTx: null, maxPerTx: null, maxPerDay: null } : r,
    );
    expect((await call('PUT', '/admin/levels', { token: ADMIN, body: { rules, cooloffs: levels.cooloffs, platform: levels.platform } })).status).toBe(200);

    const c = await call('PUT', '/admin/giftcards/categories', { token: ADMIN, body: { name: `E2E storage ${stamp}`, isActive: true } });
    expect([200, 201]).toContain(c.status);
    category = c.body.id;
    const b = await call('PUT', '/admin/giftcards/brands', { token: ADMIN, body: { name: `E2E brand ${stamp}`, categoryId: category, isActive: true } });
    expect([200, 201]).toContain(b.status);
    brand = b.body.id;
    const t = await call('PUT', '/admin/giftcards/types', { token: ADMIN, body: { brandId: brand, name: 'E2E card', currency: 'USD', minAmount: '10', maxAmount: '500', rateNgn: '1000', isActive: true } });
    expect([200, 201]).toContain(t.status);
    type = t.body.id;
  });

  afterAll(async () => {
    if (type) await call('PUT', '/admin/giftcards/types', { token: ADMIN, body: { id: type, brandId: brand, name: 'E2E card', currency: 'USD', minAmount: '10', maxAmount: '500', rateNgn: '1000', isActive: false } });
    if (brand) await call('PUT', '/admin/giftcards/brands', { token: ADMIN, body: { id: brand, name: `E2E brand ${stamp}`, categoryId: category, isActive: false } });
    if (category) await call('PUT', '/admin/giftcards/categories', { token: ADMIN, body: { id: category, name: `E2E storage ${stamp}`, isActive: false } });
    if (levels) expect((await call('PUT', '/admin/levels', { token: ADMIN, body: { rules: levels.rules, cooloffs: levels.cooloffs, platform: levels.platform } })).status).toBe(200);
  });

  it('accepts a ~4 MB sale with two photos (the old limit answered 413)', async () => {
    const r = await call('POST', '/giftcards/trades', { token: user.token, body: sale() });
    expect(r.status).toBe(201);
    expect(r.body.images).toHaveLength(2);
    tradeId = r.body.id;
  });

  it('the same sale again within 10 minutes (a retry) gives back the SAME trade', async () => {
    const r = await call('POST', '/giftcards/trades', { token: user.token, body: sale() });
    expect([200, 201]).toContain(r.status);
    expect(r.body.id).toBe(tradeId);
  });

  it('reads each photo back exactly, from the file store, never cacheable', async () => {
    const trade = await call('GET', `/giftcards/trades/${tradeId}`, { token: user.token });
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${API.replace(/\/v1$/, '')}${trade.body.images[i]}`, { headers: { authorization: `Bearer ${user.token}` } });
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(photos[i])).toBe(true);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    }
  });

  it('an admin sees the same photo, also never cacheable', async () => {
    const trade = await call('GET', `/giftcards/trades/${tradeId}`, { token: user.token });
    const adminPath = trade.body.images[0].replace('/v1/giftcards/', '/v1/admin/giftcards/');
    const res = await fetch(`${API.replace(/\/v1$/, '')}${adminPath}`, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('refuses a large request without a valid sign-in before reading it', async () => {
    const r = await call('POST', '/giftcards/trades', { body: sale() });
    expect(r.status).toBe(401);
  });

  it('other routes keep the normal 1 MB limit', async () => {
    const r = await call('POST', '/auth/login', { body: { email: 'x@davochain.invalid', password: 'y'.repeat(2 * 1024 * 1024) } });
    expect(r.status).toBe(413);
  });
});
