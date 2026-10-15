import { ADDRESS, adminToken, call, hasAdmin, login, newUser, requireServer, idNumber } from './helpers';

/**
 * Admin flows. Needs an OWNER account: set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD
 * (create one with `npm run create-admin`). Skipped otherwise.
 */
const describeAdmin = hasAdmin ? describe : describe.skip;

let ADMIN: string;

beforeAll(async () => {
  await requireServer();
  if (hasAdmin) ADMIN = (await adminToken())!;
});

describeAdmin('admin sign-in and access', () => {
  it('a wrong password is 401', async () => {
    const r = await call('POST', '/admin/auth/login', { body: { email: process.env.E2E_ADMIN_EMAIL, password: 'Wrong-password-9' } });
    expect(r.status).toBe(401);
  });

  it('no token is 401 "Missing admin token"', async () => {
    const r = await call('GET', '/admin/me');
    expect(r.status).toBe(401);
    expect(r.body.message).toBe('Missing admin token');
  });

  it('a USER token never opens an admin route', async () => {
    const u = await newUser();
    const r = await call('GET', '/admin/me', { token: u.token });
    expect(r.status).toBe(401);
  });

  it('/admin/me describes the signed-in owner', async () => {
    const r = await call('GET', '/admin/me', { token: ADMIN });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ email: process.env.E2E_ADMIN_EMAIL!.toLowerCase(), role: 'OWNER', isActive: true });
    expect(r.body.permissions).toEqual(expect.arrayContaining(['compliance.view', 'compliance.review', 'kyc.review']));
  });

  it.each([
    ['/admin/users?limit=5', 'users list'],
    ['/admin/transactions?limit=5', 'transactions'],
    ['/admin/kyc/pending', 'KYC queue'],
    ['/admin/compliance/cases', 'compliance queue'],
    ['/admin/alert-recipients', 'alert recipients'],
    ['/admin/dojah/readiness', 'Dojah readiness'],
    ['/admin/dojah/unknown-calls', 'calls to reconcile'],
  ])('GET %s (%s) answers 200', async (path) => {
    const r = await call('GET', path, { token: ADMIN });
    expect(r.status).toBe(200);
  });
});

describeAdmin('identity review: a name mismatch decided by an admin', () => {
  it('reject needs a reason of 10+ characters, then frees the user to try again', async () => {
    const u = await newUser();
    await call('POST', '/kyc/basic', {
      token: u.token,
      body: { idType: 'BVN', idNumber: idNumber('333'), firstName: 'Wrong', lastName: 'Person', dateOfBirth: '1995-03-03', address: ADDRESS, stateOfOrigin: 'Lagos', country: 'NG' },
    });
    const short = await call('POST', `/admin/kyc/${u.id}/basic-decision`, { token: ADMIN, body: { approve: false, reason: 'no' } });
    expect(short.status).toBe(400);

    const r = await call('POST', `/admin/kyc/${u.id}/basic-decision`, { token: ADMIN, body: { approve: false, reason: 'Names do not match the BVN record' } });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ state: 'REJECTED_BY_REVIEW' });

    const k = await call('GET', '/kyc', { token: u.token });
    expect(k.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'Names do not match the BVN record', underReview: false });
  });

  it('the old review route can no longer grant Basic', async () => {
    const u = await newUser();
    const r = await call('POST', `/admin/kyc/${u.id}/review`, { token: ADMIN, body: { approve: true, tier: 'TIER_1' } });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Basic is decided through basic-decision');
  });
});

describeAdmin('compliance review: a PEP hit cleared by an admin', () => {
  it('the case opens, its view is allowed, and EDD approval makes the user Basic', async () => {
    const u = await newUser();
    const raw = idNumber('222');
    const s = await call('POST', '/kyc/basic', {
      token: u.token,
      body: { idType: 'BVN', idNumber: raw, firstName: 'John', middleName: 'Doe', lastName: 'Ajayi', dateOfBirth: '2000-05-01', address: ADDRESS, stateOfOrigin: 'Lagos', country: 'NG' },
    });
    expect(s.body.state).toBe('COMPLIANCE_REVIEW');

    const list = await call('GET', '/admin/compliance/cases?filter=open', { token: ADMIN });
    const mine = (list.body as Array<{ id: string; category: string; user: { id: string } | null }>).find((c) => c.user?.id === u.id);
    expect(mine).toBeDefined();
    expect(mine!.category).toBe('PEP');

    const detail = await call('GET', `/admin/compliance/cases/${mine!.id}`, { token: ADMIN });
    expect(detail.status).toBe(200);
    expect(detail.body.screening).toMatchObject({ status: 'UNKNOWN' });
    expect(JSON.stringify(detail.body)).not.toContain(raw); // never the raw BVN

    const bad = await call('POST', `/admin/compliance/cases/${mine!.id}/decide`, { token: ADMIN, body: { decision: 'SANCTIONS_CONFIRMED', reason: 'Not a sanctions case at all' } });
    expect(bad.status).toBe(400);

    const ok = await call('POST', `/admin/compliance/cases/${mine!.id}/decide`, { token: ADMIN, body: { decision: 'PEP_APPROVED_EDD', reason: 'E2E: enhanced due diligence recorded' } });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ status: 'PEP_APPROVED_EDD' });

    const again = await call('POST', `/admin/compliance/cases/${mine!.id}/decide`, { token: ADMIN, body: { decision: 'RESTRICTED', reason: 'Changing my mind later' } });
    expect(again.status).toBe(409);

    const fresh = await login(u);
    const k = await call('GET', '/kyc', { token: fresh.token });
    expect(k.body).toMatchObject({ level: 'BASIC', basicState: 'APPROVED', underReview: false });
  });
});

describeAdmin('maintenance mode (PUT /v1/admin/site-settings)', () => {
  it('pauses money routes with 503 MAINTENANCE while reads and sign-in keep working, then resumes', async () => {
    const before = await call('GET', '/site');
    const u = await newUser();
    try {
      const on = await call('PUT', '/admin/site-settings', { token: ADMIN, body: { maintenanceMode: true, maintenanceMessage: 'E2E maintenance check.' } });
      expect(on.status).toBe(200);
      await new Promise((r) => setTimeout(r, 5_200)); // the switch is read every 5 seconds

      const q = await call('POST', '/quotes', { token: u.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'btc', amount: '50000' } });
      expect(q.status).toBe(503);
      expect(q.body).toEqual({ statusCode: 503, code: 'MAINTENANCE', message: 'E2E maintenance check.' });
      expect((await call('GET', '/kyc', { token: u.token })).status).toBe(200);
      expect((await call('POST', '/auth/login', { body: { email: u.email, password: u.password } })).status).toBe(200);
      expect((await call('GET', '/site')).body.maintenance).toEqual({ active: true, message: 'E2E maintenance check.' });
    } finally {
      await call('PUT', '/admin/site-settings', {
        token: ADMIN,
        body: { maintenanceMode: before.body.maintenance.active, maintenanceMessage: before.body.maintenance.message ?? '' },
      });
    }
    await new Promise((r) => setTimeout(r, 5_200));
    const after = await call('POST', '/quotes', { token: u.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'btc', amount: '50000' } });
    expect(after.status).toBe(403); // back to normal: this user simply isn't verified
  });
});
