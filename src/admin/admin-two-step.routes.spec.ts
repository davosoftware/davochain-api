import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminService } from './admin.service';
import { AdminAuthController, AdminController } from './admin.controller';
import { RATE_LIMIT_KEY } from '../rate-limit/rate-limit.decorator';
import { PERMISSIONS_KEY } from './require-permissions.decorator';
import { TwoStepCodeDto, TwoStepTicketDto } from './dto';
import { recordFailedLogin } from '../auth/failed-logins';

jest.mock('../auth/failed-logins', () => ({ recordFailedLogin: jest.fn() }));

/** M7 routes (spec §3–§6). */
const ADMIN = { id: 'a1', email: 'ada@davochain.test', name: 'Ada', role: 'SUB_ADMIN', isActive: true, passwordHash: 'h', failedLogins: 3, lockedUntil: null, twoStepEnabled: false };
const ctx = { ip: '203.0.113.9', userAgent: 'test' };

function loginSetup(over: Partial<typeof ADMIN>, required = false) {
  const prisma = { adminUser: { findUnique: jest.fn(async () => ({ ...ADMIN, ...over })), update: jest.fn(async () => ({})) } };
  const twoStep = {
    isRequired: jest.fn(async () => required),
    startChallenge: jest.fn(async () => ({ ticket: 'tkt' })),
    sendCode: jest.fn(async () => ({ delivered: true, sentTo: 'a**@davochain.test' })),
  };
  const svc = new AdminService(
    prisma as never, { verify: jest.fn(async () => true) } as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, twoStep as never,
  );
  jest.spyOn(svc, 'signToken').mockResolvedValue('token');
  return { svc, prisma, twoStep };
}

describe('AdminService.login with two-step sign-in', () => {
  it('two-step on: the right password gives a ticket and sends the code, never a token', async () => {
    const { svc, twoStep, prisma } = loginSetup({ twoStepEnabled: true });
    await expect(svc.login(ADMIN.email, 'pw', ctx)).resolves.toEqual({ twoStep: 'CODE', ticket: 'tkt', sentTo: 'a**@davochain.test', delivered: true });
    expect(twoStep.startChallenge).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), 'CODE', ctx.ip);
    expect(svc.signToken).not.toHaveBeenCalled();
    // The failed-attempt count is NOT reset by the password alone: only a full sign-in resets it,
    // or "right password, 4 wrong codes, right password again" would allow endless code guessing.
    expect(prisma.adminUser.update).not.toHaveBeenCalled();
  });

  it('owners require it and this admin has it off: a SETUP ticket, never a token', async () => {
    const { svc, prisma } = loginSetup({ twoStepEnabled: false }, true);
    await expect(svc.login(ADMIN.email, 'pw', ctx)).resolves.toMatchObject({ twoStep: 'SETUP', ticket: 'tkt' });
    expect(svc.signToken).not.toHaveBeenCalled();
    expect(prisma.adminUser.update).not.toHaveBeenCalled();
  });

  it('two-step off and not required: signed in as before', async () => {
    const { svc, prisma } = loginSetup({ twoStepEnabled: false });
    await expect(svc.login(ADMIN.email, 'pw', ctx)).resolves.toEqual({ accessToken: 'token' });
    expect(prisma.adminUser.update).toHaveBeenCalled();
  });
});

describe('AdminAuthController: the second step', () => {
  const routes = AdminAuthController.prototype as unknown as Record<string, () => void>;

  it('verify, resend and setup are rate limited like code entry', () => {
    for (const r of ['verifyLogin', 'resendLoginCode', 'completeTwoStepSetup']) {
      expect(Reflect.getMetadata(RATE_LIMIT_KEY, routes[r])).toBe('auth.resetConfirm');
    }
  });

  function controller() {
    const audit = jest.fn(async () => undefined);
    const twoStep = {
      verifyLogin: jest.fn(async () => ({ admin: { id: 'a1', email: 'e', role: 'SUB_ADMIN' }, usedBackup: true, backupLeft: 7 })),
      completeSetup: jest.fn(async () => ({ admin: { id: 'a1', email: 'e', role: 'SUB_ADMIN' }, backupCodes: ['111111'] })),
      sendCode: jest.fn(async () => ({ delivered: true, sentTo: 'x' })),
    };
    const admin = { audit, signToken: jest.fn(async () => 'token') };
    const c = Object.create(AdminAuthController.prototype) as AdminAuthController;
    Object.assign(c, { admin, twoStep });
    return { c, audit, twoStep, admin };
  }

  it('a right code gives a token; a backup code is recorded, never the code itself', async () => {
    const { c, audit } = controller();
    const out = await c.verifyLogin({ ticket: 'tkt', code: '123456' } as never, { ip: '1.2.3.4', headers: {} } as never);
    expect(out).toEqual({ accessToken: 'token' });
    expect(audit).toHaveBeenCalledWith('a1', 'admin.two_step.backup_used', 'AdminUser', 'a1', null, { backupLeft: 7 }, '1.2.3.4');
    expect(JSON.stringify(audit.mock.calls)).not.toContain('123456');
    expect(JSON.stringify(audit.mock.calls)).not.toContain('tkt');
  });

  it('setup gives a token and the backup codes, and records the switch-on without them', async () => {
    const { c, audit } = controller();
    const out = await c.completeTwoStepSetup({ ticket: 'tkt', code: '123456' } as never, { ip: '1.2.3.4', headers: {} } as never);
    expect(out).toEqual({ accessToken: 'token', backupCodes: ['111111'], email: 'e' });
    expect(audit).toHaveBeenCalledWith('a1', 'admin.two_step.enable', 'AdminUser', 'a1', null, { via: 'sign-in (required by an owner)' }, '1.2.3.4');
    expect(JSON.stringify(audit.mock.calls)).not.toContain('111111');
  });

  it('the forms accept only a ticket and a 6-digit code', async () => {
    expect(await validate(plainToInstance(TwoStepCodeDto, { ticket: 't'.repeat(43), code: '123456' }))).toEqual([]);
    expect((await validate(plainToInstance(TwoStepCodeDto, { ticket: 't'.repeat(43), code: '12ab56' }))).map((e) => e.property)).toEqual(['code']);
    expect((await validate(plainToInstance(TwoStepTicketDto, {}))).map((e) => e.property)).toEqual(['ticket']);
  });
});

describe('AdminController: my account and the owner setting', () => {
  const routes = AdminController.prototype as unknown as Record<string, () => void>;

  it('my-account routes need no extra permission; the owner setting needs team.manage', () => {
    for (const r of ['twoStepStatus', 'twoStepSendCode', 'twoStepEnable', 'twoStepBackupCodes', 'twoStepDisable']) {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, routes[r])).toBeUndefined();
    }
    expect(Reflect.getMetadata(PERMISSIONS_KEY, routes.setTwoStepRequired)).toEqual(['team.manage']);
  });

  it('every change is audited, never with a password or a code', async () => {
    const audit = jest.fn(async () => undefined);
    const twoStep = {
      enable: jest.fn(async () => ({ backupCodes: ['111111'] })),
      regenerate: jest.fn(async () => ['222222']),
      disable: jest.fn(async () => undefined),
      setRequired: jest.fn(async () => ({ before: false, after: true })),
    };
    const c = Object.create(AdminController.prototype) as AdminController;
    Object.assign(c, { admin: { audit }, twoStep });
    const actor = { sub: 'a1', role: 'OWNER', jti: 'j1' } as never;
    const req = { ip: '1.2.3.4' } as never;
    await c.twoStepEnable(actor, { code: '333333' } as never, req);
    await c.twoStepBackupCodes(actor, { password: 'pw-secret' } as never, req);
    await c.twoStepDisable(actor, { password: 'pw-secret', code: '444444' } as never, req);
    await c.setTwoStepRequired(actor, { required: true, password: 'pw-secret' } as never, req);
    const actions = audit.mock.calls.map((call: unknown[]) => call[1]);
    expect(actions).toEqual(['admin.two_step.enable', 'admin.two_step.backup_codes', 'admin.two_step.disable', 'admin.two_step.required']);
    const all = JSON.stringify(audit.mock.calls);
    for (const secret of ['pw-secret', '111111', '222222', '333333', '444444']) expect(all).not.toContain(secret);
    expect(twoStep.enable).toHaveBeenCalledWith('a1', '333333', 'j1');
  });
});

void recordFailedLogin;

describe('Password reset with two-step on (spec §6)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AdminsService } = require('./admins.service');

  function reset(twoStepEnabled: boolean) {
    const svc = Object.create(AdminsService.prototype);
    const signToken = jest.fn(async () => 'token');
    const admin = { id: 'a1', email: 'e@d.test', name: 'Ada A', role: 'SUB_ADMIN', passwordHash: 'old', twoStepEnabled };
    Object.assign(svc, {
      prisma: { adminUser: { findUnique: jest.fn(async () => admin), update: jest.fn(async () => admin) } },
      otps: { consume: jest.fn(async () => undefined) },
      passwords: { verify: jest.fn(async () => false), hash: jest.fn(async () => 'new') },
      sessions: { revokeAllFor: jest.fn(async () => 1) },
      templates: { render: jest.fn(async () => null) },
      mail: { send: jest.fn(async () => true) },
      admin: { signToken },
      log: { warn: jest.fn() },
    });
    return { svc, signToken };
  }

  it('changes the password but never signs a two-step admin in', async () => {
    const { svc, signToken } = reset(true);
    await expect(svc.resetPasswordWithOtp('a1', '123456', 'A-new-long-password-1')).resolves.toEqual({ signInRequired: true });
    expect(signToken).not.toHaveBeenCalled();
  });

  it('without two-step, a reset still signs the admin in, as before', async () => {
    const { svc } = reset(false);
    await expect(svc.resetPasswordWithOtp('a1', '123456', 'A-new-long-password-1')).resolves.toEqual({ accessToken: 'token' });
  });
});
