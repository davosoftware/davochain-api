import { randomUUID } from 'node:crypto';
import { call, login, newUser, requireServer, uniquePhone } from './helpers';

beforeAll(requireServer);

describe('register (POST /v1/auth/register)', () => {
  it('creates an account and returns a token pair', async () => {
    const email = `e2e-${randomUUID().slice(0, 12)}@davochain.invalid`;
    const r = await call('POST', '/auth/register', {
      body: { email, password: 'Register-test-123', firstName: 'Ada', lastName: 'Obi', phone: uniquePhone() },
    });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresIn: '15m',
      userId: expect.any(String),
    });
  });

  it('a taken email is 400 with a message that does not say which field clashed', async () => {
    const u = await newUser();
    const r = await call('POST', '/auth/register', {
      body: { email: u.email, password: 'Register-test-123', firstName: 'A', lastName: 'B', phone: uniquePhone() },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Unable to register with those details');
  });

  it('a taken phone number is the same 400, never a 500', async () => {
    const u = await newUser();
    const r = await call('POST', '/auth/register', {
      body: { email: `e2e-${randomUUID().slice(0, 12)}@davochain.invalid`, password: 'Register-test-123', firstName: 'A', lastName: 'B', phone: u.phone },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Unable to register with those details');
  });

  it('the phone number is required', async () => {
    const r = await call('POST', '/auth/register', {
      body: { email: `e2e-${randomUUID().slice(0, 12)}@davochain.invalid`, password: 'Register-test-123', firstName: 'A', lastName: 'B' },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toEqual(expect.arrayContaining(['Enter a valid phone number']));
  });

  it.each([
    ['a bad email', { email: 'not-an-email' }, 'Enter a valid email address'],
    ['a short password', { password: 'short1' }, 'Password must be at least 10 characters'],
    ['a password with no number', { password: 'onlyletters-here' }, 'Password must contain a number'],
  ])('%s is a 400 naming the problem', async (_label, override, message) => {
    const r = await call('POST', '/auth/register', {
      body: { email: `e2e-${randomUUID().slice(0, 12)}@davochain.invalid`, password: 'Register-test-123', firstName: 'A', lastName: 'B', phone: uniquePhone(), ...override },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toEqual(expect.arrayContaining([message]));
  });

  it('an unknown field is refused', async () => {
    const r = await call('POST', '/auth/register', {
      body: { email: `e2e-${randomUUID().slice(0, 12)}@davochain.invalid`, password: 'Register-test-123', firstName: 'A', lastName: 'B', phone: uniquePhone(), isAdmin: true },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toEqual(expect.arrayContaining(['property isAdmin should not exist']));
  });
});

describe('login, refresh, logout', () => {
  it('a wrong password is 401 "Incorrect email or password"', async () => {
    const u = await newUser();
    const r = await call('POST', '/auth/login', { body: { email: u.email, password: 'Wrong-password-1' } });
    expect(r.status).toBe(401);
    expect(r.body.message).toBe('Incorrect email or password');
  });

  it('an unknown email gets exactly the same answer (no account fishing)', async () => {
    const r = await call('POST', '/auth/login', { body: { email: `nobody-${randomUUID().slice(0, 8)}@davochain.invalid`, password: 'Wrong-password-1' } });
    expect(r.status).toBe(401);
    expect(r.body.message).toBe('Incorrect email or password');
  });

  it('the right password returns a token pair that works', async () => {
    const u = await login(await newUser());
    const me = await call('GET', '/me', { token: u.token });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: u.email, status: 'ACTIVE', kyc: { tier: 'TIER_0', status: 'NOT_STARTED' } });
  });

  it('a refresh token works once: the new pair works, the old token is refused', async () => {
    const u = await newUser();
    const first = await call('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } });
    expect(first.status).toBe(200);
    expect(first.body.accessToken).toEqual(expect.any(String));
    const again = await call('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } });
    expect(again.status).toBe(401);
  });

  it('after logout the refresh token no longer works', async () => {
    const u = await newUser();
    const out = await call('POST', '/auth/logout', { token: u.token, body: { refreshToken: u.refreshToken } });
    expect(out.status).toBeLessThan(300);
    const r = await call('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } });
    expect(r.status).toBe(401);
  });

  it('password reset request always answers the same, whether or not the email exists', async () => {
    const known = await newUser();
    const a = await call('POST', '/auth/reset/request', { body: { email: known.email } });
    const b = await call('POST', '/auth/reset/request', { body: { email: `nobody-${randomUUID().slice(0, 8)}@davochain.invalid` } });
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });

  it('a wrong reset code is refused', async () => {
    const u = await newUser();
    const r = await call('POST', '/auth/reset/confirm', { body: { email: u.email, code: '000000', newPassword: 'New-password-123' } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
});
