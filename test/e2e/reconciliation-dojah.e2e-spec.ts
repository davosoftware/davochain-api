import { adminToken, call, hasAdmin, newUser, requireServer, type TestUser } from './helpers';

/**
 * The reconciliation and Dojah screens' admin routes, over real HTTP. Needs
 * E2E_ADMIN_* (an OWNER). Everything changed here is put back.
 */
const describeAdmin = hasAdmin ? describe : describe.skip;

let ADMIN: string;
let user: TestUser;

beforeAll(async () => {
  await requireServer();
  if (!hasAdmin) return;
  ADMIN = (await adminToken())!;
  user = await newUser();
});

describeAdmin('reconciliation tools', () => {
  it('a coin opens to its list of customers who do not match', async () => {
    const r = await call('GET', '/admin/reconciliation/btc/customers', { token: ADMIN });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ asset: 'btc' });
    expect(Array.isArray(r.body.rows)).toBe(true);
  });

  it('an unlisted coin is refused in plain words', async () => {
    const r = await call('GET', '/admin/reconciliation/notacoin/customers', { token: ADMIN });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Choose a listed coin');
  });

  it('an owner credits then debits the same amount: the balance ends where it started, and both are listed', async () => {
    const body = (direction: 'CREDIT' | 'DEBIT') => ({ userId: user.id, asset: 'btc', direction, amount: '0.0001', reason: 'End-to-end test of a balance correction' });
    const credit = await call('POST', '/admin/reconciliation/corrections', { token: ADMIN, body: body('CREDIT') });
    expect(credit.status).toBe(201);
    expect(credit.body).toMatchObject({ before: '0', after: '0.0001' });
    const debit = await call('POST', '/admin/reconciliation/corrections', { token: ADMIN, body: body('DEBIT') });
    expect(debit.status).toBe(201);
    expect(debit.body).toMatchObject({ before: '0.0001', after: '0' });

    const list = await call('GET', '/admin/reconciliation/corrections', { token: ADMIN });
    const mine = (list.body as Array<{ userId: string; direction: string }>).filter((c) => c.userId === user.id);
    expect(mine.map((c) => c.direction).sort()).toEqual(['CREDIT', 'DEBIT']);

    // The customer sees them as "Balance correction", never the reason.
    const history = await call('GET', '/trades', { token: user.token });
    const corrections = (history.body as Array<{ label?: string; type: string }>).filter((t) => t.type === 'ADJUSTMENT');
    expect(corrections).toHaveLength(2);
    expect(corrections.every((t) => t.label === 'Balance correction')).toBe(true);
    expect(JSON.stringify(history.body)).not.toContain('End-to-end test of a balance correction');
  });

  it('a debit beyond what the customer has is refused', async () => {
    const r = await call('POST', '/admin/reconciliation/corrections', {
      token: ADMIN,
      body: { userId: user.id, asset: 'btc', direction: 'DEBIT', amount: '1', reason: 'This should be refused by the API' },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/^The customer only has /);
  });
});

describeAdmin('Dojah screen settings', () => {
  it('a value saved on the screen shows as "screen", and null puts it back to the server default', async () => {
    const before = await call('GET', '/admin/dojah/readiness', { token: ADMIN });
    expect(before.status).toBe(200);
    expect(before.body.settings).toBeDefined();

    const saved = await call('PUT', '/admin/dojah/settings', { token: ADMIN, body: { dailyAttempts: 4, totalAttempts: 12 } });
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toMatchObject({ dailyAttempts: 4, totalAttempts: 12, source: { dailyAttempts: 'screen', totalAttempts: 'screen' } });

    const reset = await call('PUT', '/admin/dojah/settings', { token: ADMIN, body: { dailyAttempts: null, totalAttempts: null } });
    expect(reset.status).toBe(200);
    expect(reset.body.settings.source).toMatchObject({ dailyAttempts: 'server', totalAttempts: 'server' });
  });

  it('daily tries above the total are refused in plain words', async () => {
    const r = await call('PUT', '/admin/dojah/settings', { token: ADMIN, body: { dailyAttempts: 15, totalAttempts: 5 } });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Tries must be whole numbers from 1 to 20, and the daily number can't be more than the total.");
  });

  it('the Basic switch needs the right password', async () => {
    const r = await call('POST', '/admin/dojah/basic-switch', { token: ADMIN, body: { enabled: false, password: 'Not-the-password-1' } });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('That password is not correct.');
  });

  it('the calculator answers with numbers and the working, and saves nothing', async () => {
    const r = await call('POST', '/admin/dojah/thresholds', { token: ADMIN, body: { lookupPrice: 100, amlPrice: 50 } });
    expect(r.status).toBe(200);
    expect(r.body.minBalance).toBeGreaterThan(0);
    expect(r.body.lowBalanceWarn).toBeGreaterThan(r.body.minBalance);
    expect(r.body.workings[0]).toMatch(/^One verification can cost up to/);
  });
});
