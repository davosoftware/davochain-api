import { ADDRESS, adminToken, call, credit, hasAdmin, newUser, requireServer, verifyBasic } from './helpers';

/**
 * People → Users → Close account (28 Oct 2026), end to end: refused while
 * money is held, then closed by an owner; the person can't sign in, and can
 * register again with the same email and phone and verify with the same BVN.
 */
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const describeAdmin = hasAdmin ? describe : describe.skip;

let admin: string;
beforeAll(async () => {
  await requireServer();
  if (hasAdmin) admin = (await adminToken())!;
});

describeAdmin('closing a customer account', () => {
  it('is refused while the customer holds money, saying what is left', async () => {
    const user = await newUser();
    credit(user, 'ngn', '2500');
    const check = await call('GET', `/admin/users/${user.id}/close-check`, { token: admin });
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({ canClose: false, blockers: [expect.objectContaining({ code: 'BALANCE', asset: 'ngn' })] });
    const r = await call('POST', `/admin/users/${user.id}/close`, { token: admin, body: { password: PASSWORD, reason: 'Testing the closing refusal' } });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ACCOUNT_NOT_EMPTY');
  });

  it('needs the owner password', async () => {
    const user = await newUser();
    const r = await call('POST', `/admin/users/${user.id}/close`, { token: admin, body: { password: 'not-the-password-1', reason: 'Testing the wrong password' } });
    expect(r.status).toBe(400);
  });

  it('closes an empty account: sign-in stops, and the person can start again with the same details', async () => {
    const user = await verifyBasic(await newUser());
    const bvn = user.bvn!;
    expect((await call('GET', `/admin/users/${user.id}/close-check`, { token: admin })).body).toEqual({ canClose: true, blockers: [] });

    const r = await call('POST', `/admin/users/${user.id}/close`, { token: admin, body: { password: PASSWORD, reason: 'Customer asked us to close it' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ closed: true });

    // Money stops at once (like a suspension), the session can't be renewed, and sign-in fails.
    // A sign-in token already issued can still read its own profile until it expires (at most 15 min).
    const quote = await call('POST', '/quotes', { token: user.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'usdt', amount: '5000' } });
    expect(quote.status).toBe(403);
    expect((await call('POST', '/auth/refresh', { body: { refreshToken: user.refreshToken } })).status).toBe(401);
    expect((await call('POST', '/auth/login', { body: { email: user.email, password: user.password } })).status).toBe(401);

    // The admin still sees it, found by the original email.
    const detail = await call('GET', `/admin/users/${user.id}`, { token: admin });
    expect(detail.body).toMatchObject({ status: 'CLOSED', closedEmail: user.email, closedPhone: user.phone, closedReason: 'Customer asked us to close it' });
    const found = await call('GET', `/admin/users?search=${encodeURIComponent(user.email)}`, { token: admin });
    expect((found.body.rows as Array<{ id: string }>).map((u) => u.id)).toContain(user.id);

    // Same email and phone register again, and the same BVN verifies the new account.
    const again = await call('POST', '/auth/register', { body: { email: user.email, password: user.password, firstName: 'Someone', lastName: 'Clean', phone: user.phone } });
    expect(again.status).toBe(201);
    const { execSync } = await import('node:child_process');
    const { join } = await import('node:path');
    execSync(`node scripts/dev-verify-email.mjs --email ${user.email}`, { cwd: join(__dirname, '..', '..'), stdio: 'ignore' });
    const basic = await call('POST', '/kyc/basic', {
      token: again.body.accessToken,
      body: { idType: 'BVN', idNumber: bvn, firstName: 'Someone', lastName: 'Clean', dateOfBirth: '1995-03-03', address: ADDRESS, stateOfOrigin: 'Lagos', country: 'NG' },
    });
    expect(basic.status).toBe(201);
    expect(basic.body.state).toBe('APPROVED');

    // Closing it twice is refused.
    const twice = await call('POST', `/admin/users/${user.id}/close`, { token: admin, body: { password: PASSWORD, reason: 'Customer asked us to close it' } });
    expect(twice.status).toBe(409);
  });
});
