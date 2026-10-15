import { adminToken, call, credit, hasAdmin, newUser, requireServer, verifyBasic, type TestUser } from './helpers';

/**
 * Verification levels (level policy, 15 Oct 2026): an admin's rule decides at
 * once, over real HTTP, with no restart. Needs E2E_ADMIN_* (see admin.e2e-spec.ts).
 * Every rule changed here is put back in afterAll.
 */
const describeAdmin = hasAdmin ? describe : describe.skip;

type View = {
  rules: Array<{ level: string; action: string; allowed: boolean; currency: string; minPerTx: string | null; maxPerTx: string | null; maxPerDay: string | null }>;
  cooloffs: unknown[];
  platform: unknown;
};

let ADMIN: string;
let original: View;
let user: TestUser;

const save = (view: View) =>
  call('PUT', '/admin/levels', { token: ADMIN, body: { rules: view.rules, cooloffs: view.cooloffs, platform: view.platform } });

const withRule = (view: View, action: string, patch: Partial<View['rules'][number]>): View => ({
  ...view,
  rules: view.rules.map((r) => (r.level === 'BASIC' && r.action === action ? { ...r, ...patch } : r)),
});

beforeAll(async () => {
  await requireServer();
  if (!hasAdmin) return;
  ADMIN = (await adminToken())!;
  const r = await call('GET', '/admin/levels', { token: ADMIN });
  expect(r.status).toBe(200);
  original = r.body;
  user = await verifyBasic(await newUser());
  credit(user, 'ngn', '1000000');
});

afterAll(async () => {
  if (hasAdmin && original) expect((await save(original)).status).toBe(200);
});

describeAdmin('verification levels: the admin rules decide', () => {
  it('GET /admin/levels lists every action, the rules, cool-offs and the platform limit', () => {
    expect(original.rules.length).toBeGreaterThan(0);
    expect(original.rules.find((r) => r.level === 'BASIC' && r.action === 'GIFTCARD_SELL')).toBeDefined();
  });

  it('gift cards switched off for every level: 403 NOT_ALLOWED_AT_LEVEL, requiredLevel null', async () => {
    const off: View = { ...original, rules: original.rules.map((r) => (r.action === 'GIFTCARD_SELL' ? { ...r, allowed: false } : r)) };
    expect((await save(off)).status).toBe(200);
    // The guard runs before the body is read, so any body shows the gate.
    const r = await call('POST', '/giftcards/trades', { token: user.token, body: { typeId: 'x', faceValue: '10', code: 'ABC' } });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'NOT_ALLOWED_AT_LEVEL', action: 'GIFTCARD_SELL', requiredLevel: null });
  });

  it('a Basic buy limit of $100 a day refuses a bigger buy quote, and /me/level shows it', async () => {
    const limited = withRule(original, 'BUY', { allowed: true, currency: 'USD', minPerTx: null, maxPerTx: null, maxPerDay: '100' });
    expect((await save(limited)).status).toBe(200);

    const q = await call('POST', '/quotes', { token: user.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'btc', amount: '400000' } });
    expect(q.status).toBe(400);
    expect(q.body.message).toContain('daily limit');

    const me = await call('GET', '/me/level', { token: user.token });
    expect(me.status).toBe(200);
    expect(me.body.level).toBe('BASIC');
    expect(me.body.actions.find((a: { action: string }) => a.action === 'BUY')).toMatchObject({ allowed: true, currency: 'USD', maxPerDay: '100.00' });
  });
});
