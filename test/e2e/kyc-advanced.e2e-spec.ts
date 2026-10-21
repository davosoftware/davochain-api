import { randomUUID } from 'node:crypto';
import { API, adminToken, call, hasAdmin, login, newUser, requireServer, verifyBasic, type TestUser } from './helpers';
import { mockImage } from '../../src/dojah/dojah.mock';

/**
 * Advanced verification over real HTTP (spec 2026-10-21), on the Dojah mock and
 * the in-memory file store. Images carry a marker that tells the mock which
 * answer to give (src/dojah/dojah.mock.ts).
 */
beforeAll(requireServer);

const unique = () => randomUUID().slice(0, 8);

async function upload(token: string, type: string, scenario?: string, mime = 'image/png'): Promise<string> {
  const bytes = mime === 'application/pdf' ? Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(`${unique()} `.repeat(10))]) : mockImage(scenario);
  const form = new FormData();
  form.append('type', type);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), 'f');
  const res = await fetch(`${API}/kyc/documents`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  const body = await res.json();
  // 200 = the same file again (a retry): the API hands back the first record.
  if (res.status !== 201 && res.status !== 200) throw new Error(`upload ${type}: ${res.status} ${JSON.stringify(body)}`);
  return body.id as string;
}

async function waitFor(token: string, step: 'identity' | 'address') {
  for (let i = 0; i < 80; i++) {
    const k = await call('GET', '/kyc', { token });
    if (k.body.advanced[step].state !== 'CHECKING') return k.body.advanced[step];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${step} still CHECKING after 20 s`);
}

async function identity(u: TestUser, s: { front?: string; selfie?: string } = {}) {
  const front = await upload(u.token, 'NATIONAL_ID', s.front ?? `front-${unique()}`);
  const back = await upload(u.token, 'ID_BACK', `back-${unique()}`);
  const selfie = await upload(u.token, 'SELFIE', s.selfie ?? `selfie-${unique()}`);
  return call('POST', '/kyc/advanced/identity', { token: u.token, body: { idType: 'NATIONAL_ID', frontDocumentId: front, backDocumentId: back, selfieDocumentId: selfie } });
}

async function toTier2(): Promise<TestUser> {
  const u = await verifyBasic(await newUser());
  await identity(u);
  const s = await waitFor(u.token, 'identity');
  if (s.state !== 'APPROVED') throw new Error(`identity step did not approve: ${JSON.stringify(s)}`);
  return login(u);
}

describe('Advanced Step A over HTTP', () => {
  it('202 CHECKING, then APPROVED; after signing in again the level is Advanced (in progress)', async () => {
    const u = await verifyBasic(await newUser());
    const r = await identity(u);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ verificationId: expect.any(String), state: 'CHECKING' });
    expect(await waitFor(u.token, 'identity')).toMatchObject({ state: 'APPROVED', reason: null });
    const fresh = await login(u);
    expect((await call('GET', '/kyc', { token: fresh.token })).body).toMatchObject({ tier: 'TIER_2', level: 'ADVANCED_IN_PROGRESS' });
  });

  it('an expired ID is rejected with the customer message, and one attempt is used', async () => {
    const u = await verifyBasic(await newUser());
    await identity(u, { front: 'id-expired' });
    expect(await waitFor(u.token, 'identity')).toEqual({
      state: 'REJECTED',
      reason: "This ID has expired. Please use one that's still valid.",
      attemptsLeft: { today: 2, total: 9 },
    });
  });

  it('403 before Basic; 409 for a second submit while one is waiting for a person', async () => {
    const fresh = await newUser();
    const early = await call('POST', '/kyc/advanced/identity', { token: fresh.token, body: { idType: 'PASSPORT', frontDocumentId: randomUUID(), selfieDocumentId: randomUUID() } });
    expect(early.status).toBe(403);
    const u = await verifyBasic(await newUser());
    await identity(u, { selfie: 'match-borderline' });
    expect(await waitFor(u.token, 'identity')).toMatchObject({ state: 'IN_REVIEW' });
    expect((await identity(u)).status).toBe(409);
  });

  it('a document that belongs to someone else is 400 and uses no attempt', async () => {
    const a = await verifyBasic(await newUser());
    const b = await verifyBasic(await newUser());
    const theirs = await upload(b.token, 'NATIONAL_ID', `theirs-${unique()}`);
    const r = await call('POST', '/kyc/advanced/identity', {
      token: a.token,
      body: { idType: 'NATIONAL_ID', frontDocumentId: theirs, backDocumentId: await upload(a.token, 'ID_BACK', `b-${unique()}`), selfieDocumentId: await upload(a.token, 'SELFIE', `s-${unique()}`) },
    });
    expect(r.status).toBe(400);
    expect((await call('GET', '/kyc', { token: a.token })).body.advanced.identity).toMatchObject({ state: 'NONE', attemptsLeft: { today: 3, total: 10 } });
  });

  it('a PDF as the ID is refused at once', async () => {
    const u = await verifyBasic(await newUser());
    const pdf = await upload(u.token, 'NATIONAL_ID', undefined, 'application/pdf');
    const r = await call('POST', '/kyc/advanced/identity', {
      token: u.token,
      body: { idType: 'NATIONAL_ID', frontDocumentId: pdf, backDocumentId: await upload(u.token, 'ID_BACK', `b-${unique()}`), selfieDocumentId: await upload(u.token, 'SELFIE', `s-${unique()}`) },
    });
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/photo, not a PDF/);
  });
});

describe('Advanced Step B over HTTP', () => {
  it('a utility bill takes a TIER_2 customer to Advanced', async () => {
    const u = await toTier2();
    const doc = await upload(u.token, 'PROOF_OF_ADDRESS', `bill-${unique()}`);
    expect((await call('POST', '/kyc/advanced/address', { token: u.token, body: { kind: 'UTILITY_BILL', documentId: doc } })).status).toBe(202);
    expect(await waitFor(u.token, 'address')).toMatchObject({ state: 'APPROVED' });
    expect((await call('GET', '/kyc', { token: (await login(u)).token })).body).toMatchObject({ tier: 'TIER_3', level: 'ADVANCED' });
  });

  it('a PDF bank statement waits for a person', async () => {
    const u = await toTier2();
    const doc = await upload(u.token, 'PROOF_OF_ADDRESS', undefined, 'application/pdf');
    await call('POST', '/kyc/advanced/address', { token: u.token, body: { kind: 'BANK_STATEMENT', documentId: doc } });
    expect(await waitFor(u.token, 'address')).toMatchObject({ state: 'IN_REVIEW', reason: "We're checking your documents. This usually takes less than a day." });
  });

  it('an old statement is rejected with the recency message', async () => {
    const u = await toTier2();
    const doc = await upload(u.token, 'PROOF_OF_ADDRESS', 'addr-old');
    await call('POST', '/kyc/advanced/address', { token: u.token, body: { kind: 'BANK_STATEMENT', documentId: doc } });
    expect(await waitFor(u.token, 'address')).toMatchObject({ state: 'REJECTED', reason: expect.stringMatching(/last 3 months/) });
  });
});

(hasAdmin ? describe : describe.skip)('admins decide Advanced checks', () => {
  it('a borderline face match appears on the queue; the old route refuses; approving makes the customer TIER_2', async () => {
    const ADMIN = (await adminToken())!;
    const u = await verifyBasic(await newUser());
    await identity(u, { selfie: 'match-borderline' });
    await waitFor(u.token, 'identity');
    const q = await call('GET', '/admin/kyc/advanced', { token: ADMIN });
    expect(q.status).toBe(200);
    const row = q.body.rows.find((r: { user: { id: string } }) => r.user.id === u.id);
    expect(row).toMatchObject({ step: 'IDENTITY', reviewReasons: ['FACE_MATCH_BORDERLINE'], verified: { firstName: 'Someone', lastName: 'Clean' } });
    expect(JSON.stringify(row)).not.toMatch(/portrait|bW9jay1wb3J0cmFpdA/);
    const old = await call('POST', `/admin/kyc/${u.id}/review`, { token: ADMIN, body: { approve: true, tier: 'TIER_2', reason: 'x' } });
    expect(old.status).toBe(409);
    const d = await call('POST', `/admin/kyc/advanced/${row.id}/decision`, { token: ADMIN, body: { approve: true, reason: 'APPROVED_AFTER_REVIEW' } });
    expect(d.body).toEqual({ state: 'APPROVED' });
    expect((await call('GET', '/kyc', { token: (await login(u)).token })).body.tier).toBe('TIER_2');
    const again = await call('POST', `/admin/kyc/advanced/${row.id}/decision`, { token: ADMIN, body: { approve: false, reason: 'DOC_UNCLEAR' } });
    expect(again.status).toBe(404);
  });
});
