import { adminToken, call, hasAdmin, login, newUser, requireServer } from './helpers';

/**
 * System → Server settings and the emergency sign-out (spec 2026-10-26), over
 * real HTTP. Needs E2E_ADMIN_* (an OWNER). The one setting it changes is put
 * back. Signing every customer out only ends sessions made before it, so the
 * specs that run after this one (which register fresh users) are not affected.
 */
const describeAdmin = hasAdmin ? describe : describe.skip;
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const REASON = 'end-to-end test of server settings';

let ADMIN: string;

beforeAll(async () => {
  await requireServer();
  if (hasAdmin) ADMIN = (await adminToken())!;
});

afterAll(async () => {
  if (hasAdmin) await call('DELETE', '/admin/server-settings/QUOTE_TTL_SECONDS', { token: ADMIN, body: { password: PASSWORD, reason: REASON } });
});

describeAdmin('Server settings', () => {
  it('an owner sees every setting with its value and where it comes from', async () => {
    const r = await call('GET', '/admin/server-settings', { token: ADMIN });
    expect(r.status).toBe(200);
    expect(r.body.owner).toBe(true);
    const ttl = r.body.settings.find((s: { key: string }) => s.key === 'QUOTE_TTL_SECONDS');
    expect(ttl).toMatchObject({ group: 'Trading', kind: 'int', min: 5, max: 120, live: true, money: false });
    expect(r.body.settings.map((s: { key: string }) => s.key)).not.toContain('DATABASE_URL');
  });

  it('a wrong password, a short reason or a value out of range changes nothing', async () => {
    const wrong = await call('PUT', '/admin/server-settings/QUOTE_TTL_SECONDS', { token: ADMIN, body: { value: 20, password: 'Not-the-password-1', reason: REASON } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toBe('That password is not correct.');

    const short = await call('PUT', '/admin/server-settings/QUOTE_TTL_SECONDS', { token: ADMIN, body: { value: 20, password: PASSWORD, reason: 'because' } });
    expect(short.status).toBe(400);

    const range = await call('PUT', '/admin/server-settings/QUOTE_TTL_SECONDS', { token: ADMIN, body: { value: 999, password: PASSWORD, reason: REASON } });
    expect(range.status).toBe(400);
  });

  it('settings that stay in .env cannot be changed here', async () => {
    const r = await call('PUT', '/admin/server-settings/DATABASE_URL', { token: ADMIN, body: { value: 'x', password: PASSWORD, reason: REASON } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/stays in the server's \.env file/);
  });

  it('an owner changes a setting, and reset puts the server value back', async () => {
    const set = await call('PUT', '/admin/server-settings/QUOTE_TTL_SECONDS', { token: ADMIN, body: { value: 21, password: PASSWORD, reason: REASON } });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ key: 'QUOTE_TTL_SECONDS', value: 21, source: 'dashboard' });

    const audit = await call('GET', '/admin/audit?action=server_setting.set', { token: ADMIN });
    if (audit.status === 200) expect(JSON.stringify(audit.body)).toContain('QUOTE_TTL_SECONDS');

    const reset = await call('DELETE', '/admin/server-settings/QUOTE_TTL_SECONDS', { token: ADMIN, body: { password: PASSWORD, reason: REASON } });
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ key: 'QUOTE_TTL_SECONDS', source: 'server' });
  });
});

describeAdmin('Emergency: sign out all customers', () => {
  it('needs the password', async () => {
    const r = await call('POST', '/admin/emergency/sign-out-customers', { token: ADMIN, body: { password: 'Not-the-password-1', reason: REASON } });
    expect(r.status).toBe(400);
  });

  it('ends every customer session; signing in again works', async () => {
    const user = await newUser('Signout', 'Tester');
    expect((await call('GET', '/me', { token: user.token })).status).toBe(200);

    const r = await call('POST', '/admin/emergency/sign-out-customers', { token: ADMIN, body: { password: PASSWORD, reason: REASON } });
    expect(r.status).toBe(200);
    expect(r.body.refreshTokensRevoked).toBeGreaterThanOrEqual(1);

    const me = await call('GET', '/me', { token: user.token });
    expect(me.status).toBe(401);
    expect(me.body.message).toBe('Session expired. Please sign in again.');
    expect((await call('POST', '/auth/refresh', { body: { refreshToken: user.refreshToken } })).status).toBe(401);

    // Tokens carry whole seconds: one made in the same second as the cut-off is refused too.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const again = await login(user);
    expect((await call('GET', '/me', { token: again.token })).status).toBe(200);

    // Admins are not signed out.
    expect((await call('GET', '/admin/server-settings', { token: ADMIN })).status).toBe(200);
  });
});
