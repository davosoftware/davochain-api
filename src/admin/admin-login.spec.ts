import { UnauthorizedException } from '@nestjs/common';
import { AlertType } from '@prisma/client';
import { AdminService } from './admin.service';
import { AdminsService } from './admins.service';
import { recordFailedLogin } from '../auth/failed-logins';
import { HashBusyError } from '../auth/hash-semaphore';

jest.mock('../auth/failed-logins', () => ({ recordFailedLogin: jest.fn() }));
const record = recordFailedLogin as jest.MockedFunction<typeof recordFailedLogin>;

const ADMIN = {
  id: 'admin-1',
  email: 'owner@davochain.test',
  role: 'OWNER',
  isActive: true,
  passwordHash: 'scrypt$stored',
  failedLogins: 0,
  lockedUntil: null as Date | null,
};

function setup(admin: Partial<typeof ADMIN> | null = {}) {
  const prisma = {
    adminUser: {
      findUnique: jest.fn(async () => (admin === null ? null : { ...ADMIN, ...admin })),
      update: jest.fn(async () => ({})),
    },
    adminAuditLog: { create: jest.fn(async () => ({})) },
  };
  const passwords = { verify: jest.fn(async () => false), dummyVerify: jest.fn(async () => undefined) };
  const alerts = { raise: jest.fn(async () => true) };
  const svc = new AdminService(
    prisma as never, passwords as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, alerts as never,
  );
  jest.spyOn(svc, 'signToken').mockResolvedValue('token');
  return { svc, prisma, passwords, alerts };
}

const ctx = { ip: '203.0.113.9', userAgent: 'curl' };

describe('AdminService.login lockout', () => {
  beforeEach(() => record.mockReset());

  it('treats an unknown admin with a dummy hash and a counting transaction on no row, so it costs what a real one does', async () => {
    const { svc, passwords, prisma } = setup(null);
    record.mockResolvedValue({ failedLogins: 0, lockedUntil: null, justLocked: false });
    await expect(svc.login('nobody@x.com', 'pw', ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(passwords.dummyVerify).toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(prisma, 'admin_users', expect.not.stringMatching(/^admin-1$/));
  });

  it('gives an inactive admin the same cost too, without touching its counter', async () => {
    const { svc, prisma } = setup({ isActive: false });
    record.mockResolvedValue({ failedLogins: 0, lockedUntil: null, justLocked: false });
    await expect(svc.login(ADMIN.email, 'pw', ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalledWith(prisma, 'admin_users', 'admin-1');
  });

  it('answers a locked admin exactly like a wrong password, at the same cost, so the lock does not confirm the email', async () => {
    const until = new Date(Date.now() + 10 * 60_000);
    const { svc, passwords } = setup({ lockedUntil: until });
    const err = await svc.login(ADMIN.email, 'even-the-right-password', ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).message).toBe('Incorrect email or password');
    expect(JSON.stringify((err as UnauthorizedException).getResponse())).not.toMatch(/lock|attempt|after/i);
    expect(passwords.verify).not.toHaveBeenCalled();
    expect(passwords.dummyVerify).toHaveBeenCalledTimes(1);
    // Same database work as a wrong password, on a row that does not exist: the locked admin's counter is untouched.
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalledWith(expect.anything(), 'admin_users', 'admin-1');
  });

  it('does not count a login refused because the hash queue is full: a busy server is not a wrong password', async () => {
    const { svc, prisma, passwords, alerts } = setup();
    passwords.verify.mockRejectedValue(new HashBusyError());
    const err = await svc.login(ADMIN.email, 'pw', ctx).catch((e: unknown) => e);
    expect((err as HashBusyError).getStatus()).toBe(503);
    expect(record).not.toHaveBeenCalled();
    expect(prisma.adminUser.update).not.toHaveBeenCalled();
    expect(alerts.raise).not.toHaveBeenCalled();
  });

  it('lets an admin whose lock has expired try again', async () => {
    const { svc, passwords } = setup({ lockedUntil: new Date(Date.now() - 60_000) });
    record.mockResolvedValue({ failedLogins: 6, lockedUntil: null, justLocked: false });
    await expect(svc.login(ADMIN.email, 'wrong', ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(passwords.verify).toHaveBeenCalled();
  });

  it('counts a wrong password atomically and answers 401, with no alert before the lock', async () => {
    const { svc, prisma, alerts } = setup();
    record.mockResolvedValue({ failedLogins: 2, lockedUntil: null, justLocked: false });
    await expect(svc.login(ADMIN.email, 'wrong', ctx)).rejects.toThrow('Incorrect email or password');
    expect(record).toHaveBeenCalledWith(prisma, 'admin_users', 'admin-1');
    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
    expect(alerts.raise).not.toHaveBeenCalled();
  });

  it('audits and alerts on the failure that locks, and still answers 401', async () => {
    const { svc, prisma, alerts } = setup();
    const until = new Date(Date.now() + 15 * 60_000);
    record.mockResolvedValue({ failedLogins: 5, lockedUntil: until, justLocked: true });
    await expect(svc.login(ADMIN.email, 'wrong', ctx)).rejects.toThrow('Incorrect email or password');
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ adminUserId: 'admin-1', action: 'admin.locked', entity: 'AdminUser', entityId: 'admin-1', ip: '203.0.113.9' }),
    });
    expect(alerts.raise).toHaveBeenCalledWith(
      AlertType.ADMIN_LOCKOUT,
      'admin-lockout:admin-1',
      expect.stringMatching(/admin account was locked/i),
      expect.arrayContaining([expect.stringContaining('203.0.113.9')]),
    );
  });

  it('answers the failure that locks without waiting for the alert email', async () => {
    const { svc, alerts } = setup();
    alerts.raise.mockImplementation(() => new Promise<boolean>(() => undefined)); // SMTP that never answers
    record.mockResolvedValue({ failedLogins: 5, lockedUntil: new Date(Date.now() + 15 * 60_000), justLocked: true });
    const answer = svc.login(ADMIN.email, 'wrong', ctx).then(
      () => 'resolved',
      (e: unknown) => (e instanceof UnauthorizedException ? '401' : 'other'),
    );
    const winner = await Promise.race([answer, new Promise((r) => setTimeout(() => r('still waiting'), 500))]);
    expect(winner).toBe('401');
    expect(alerts.raise).toHaveBeenCalledTimes(1);
  });

  it('clears the counter and lock on success', async () => {
    const { svc, prisma, passwords } = setup({ failedLogins: 3 });
    passwords.verify.mockResolvedValue(true);
    await expect(svc.login(ADMIN.email, 'right', ctx)).resolves.toEqual({ accessToken: 'token' });
    expect(prisma.adminUser.update).toHaveBeenCalledWith({
      where: { id: 'admin-1' },
      data: expect.objectContaining({ failedLogins: 0, lockedUntil: null, lastLoginAt: expect.any(Date) }),
    });
  });
});

describe('AdminsService password reset', () => {
  it('a completed reset clears the lockout along with the new password', async () => {
    const prisma = {
      adminUser: {
        findUnique: jest.fn(async () => ({ ...ADMIN, lockedUntil: new Date(Date.now() + 600_000), failedLogins: 5 })),
        update: jest.fn(async () => ({ ...ADMIN, name: 'Owner One' })),
      },
    };
    const passwords = { verify: jest.fn(async () => false), hash: jest.fn(async () => 'scrypt$new') };
    const admin = { signToken: jest.fn(async () => 'token') };
    const sessions = { revokeAllFor: jest.fn(async () => undefined) };
    const otps = { consume: jest.fn(async () => undefined) };
    const templates = { render: jest.fn(async () => null) };
    const svc = new AdminsService(
      prisma as never, passwords as never, admin as never, sessions as never, otps as never, {} as never, {} as never, templates as never,
    );
    await svc.resetPasswordWithOtp('admin-1', '123456', 'a-brand-new-password-9');
    expect(prisma.adminUser.update).toHaveBeenCalledWith({
      where: { id: 'admin-1' },
      data: expect.objectContaining({ passwordHash: 'scrypt$new', failedLogins: 0, lockedUntil: null }),
    });
  });
});
