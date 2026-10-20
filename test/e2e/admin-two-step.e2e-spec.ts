import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { call, requireServer } from './helpers';

/**
 * Admin two-step sign-in (M7, 20 Oct 2026) over real HTTP. Uses a dedicated
 * test owner (e2e-twostep@davochain.invalid) so the main e2e owner is never
 * switched; the e2e server has no mail, so a script sets a known code on the
 * newest open one. Everything is put back in afterAll.
 */
const EMAIL = 'e2e-twostep@davochain.invalid';
const PASSWORD = 'Two-step-e2e-password-9';
const MAIN_OWNER = process.env.E2E_ADMIN_EMAIL;
const MAIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

function script(args: string): void {
  execSync(`node scripts/e2e-admin-two-step.mjs ${args}`, { cwd: join(__dirname, '..', '..'), stdio: 'pipe' });
}
const setCode = (purpose: 'LOGIN' | 'TWO_STEP_CHANGE', value: string) => script(`--code ${EMAIL} --purpose ${purpose} --value ${value}`);
const signIn = () => call('POST', '/admin/auth/login', { body: { email: EMAIL, password: PASSWORD } });

let token: string;
let backupCodes: string[];

beforeAll(async () => {
  await requireServer();
  script(`--clear-flag --ensure ${EMAIL} --password ${PASSWORD}`);
  const r = await signIn();
  expect(r.status).toBe(200);
  token = r.body.accessToken;
});

afterAll(() => {
  script(`--clear-flag --ensure ${EMAIL} --password ${PASSWORD}`);
});

describe('admin two-step sign-in', () => {
  it('starts off: status says so', async () => {
    const r = await call('GET', '/admin/me/two-step', { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: false, backupCodesLeft: 0, required: false });
  });

  it('switching on needs the password, then the emailed code; it gives 10 backup codes', async () => {
    expect((await call('POST', '/admin/me/two-step/code', { token, body: { password: 'wrong-password' } })).status).toBe(400);
    const sent = await call('POST', '/admin/me/two-step/code', { token, body: { password: PASSWORD } });
    expect(sent.status).toBe(200);
    expect(sent.body.sentTo).toMatch(/^e\*+@davochain\.invalid$/);
    setCode('TWO_STEP_CHANGE', '515151');
    expect((await call('POST', '/admin/me/two-step/enable', { token, body: { code: '000000' } })).status).toBe(400);
    const on = await call('POST', '/admin/me/two-step/enable', { token, body: { code: '515151' } });
    expect(on.status).toBe(200);
    backupCodes = on.body.backupCodes;
    expect(backupCodes).toHaveLength(10);
  });

  it('the right password now gives a ticket, not a token', async () => {
    const r = await signIn();
    expect(r.status).toBe(200);
    expect(r.body.twoStep).toBe('CODE');
    expect(r.body.sentTo).toMatch(/^e\*+@davochain\.invalid$/);
    expect(r.body.accessToken).toBeUndefined();
    expect(typeof r.body.ticket).toBe('string');
  });

  it('the emailed code finishes the sign-in, once', async () => {
    const r = await signIn();
    setCode('LOGIN', '626262');
    expect((await call('POST', '/admin/auth/login/verify', { body: { ticket: r.body.ticket, code: '000000' } })).status).toBe(400);
    const ok = await call('POST', '/admin/auth/login/verify', { body: { ticket: r.body.ticket, code: '626262' } });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.accessToken).toBe('string');
    token = ok.body.accessToken;
    expect((await call('POST', '/admin/auth/login/verify', { body: { ticket: r.body.ticket, code: '626262' } })).status).toBe(401);
  });

  it('a backup code works once', async () => {
    const r1 = await signIn();
    const ok = await call('POST', '/admin/auth/login/verify', { body: { ticket: r1.body.ticket, code: backupCodes[0] } });
    expect(ok.status).toBe(200);
    token = ok.body.accessToken;
    const r2 = await signIn();
    expect((await call('POST', '/admin/auth/login/verify', { body: { ticket: r2.body.ticket, code: backupCodes[0] } })).status).toBe(400);
    const status = await call('GET', '/admin/me/two-step', { token });
    expect(status.body.backupCodesLeft).toBe(9);
  });

  it('a made-up ticket is refused', async () => {
    const r = await call('POST', '/admin/auth/login/verify', { body: { ticket: 'x'.repeat(43), code: '123456' } });
    expect(r.status).toBe(401);
  });

  it('an owner with two-step on can require it; then an admin without it must set it up at sign-in', async () => {
    const on = await call('PUT', '/admin/settings/two-step-required', { token, body: { required: true, password: PASSWORD } });
    expect(on.status).toBe(200);
    try {
      if (MAIN_OWNER && MAIN_PASSWORD) {
        const main = await call('POST', '/admin/auth/login', { body: { email: MAIN_OWNER, password: MAIN_PASSWORD } });
        expect(main.status).toBe(200);
        expect(main.body).toMatchObject({ twoStep: 'SETUP' });
        expect(main.body.accessToken).toBeUndefined();
      }
      // While required, switching off is refused.
      const off = await call('POST', '/admin/me/two-step/disable', { token, body: { password: PASSWORD, code: backupCodes[1] } });
      expect(off.status).toBe(409);
    } finally {
      const back = await call('PUT', '/admin/settings/two-step-required', { token, body: { required: false, password: PASSWORD } });
      expect(back.status).toBe(200);
    }
  });

  it('switching off needs the password and a code; afterwards the password alone signs in', async () => {
    const off = await call('POST', '/admin/me/two-step/disable', { token, body: { password: PASSWORD, code: backupCodes[2] } });
    expect(off.status).toBe(200);
    const r = await signIn();
    expect(typeof r.body.accessToken).toBe('string');
  });
});
