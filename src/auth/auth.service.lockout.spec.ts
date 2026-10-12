import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { AuthService } from './auth.service';
import { HashBusyError } from './hash-semaphore';
import { recordFailedLogin } from './failed-logins';

jest.mock('./failed-logins', () => ({ ...jest.requireActual('./failed-logins'), recordFailedLogin: jest.fn() }));
const record = recordFailedLogin as jest.MockedFunction<typeof recordFailedLogin>;

const USER = {
  id: 'user-1',
  email: 'ada@davochain.test',
  passwordHash: 'scrypt$stored',
  status: UserStatus.ACTIVE,
  failedLogins: 0,
  lockedUntil: null as Date | null,
};

function setup(user: Partial<typeof USER> = {}) {
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ ...USER, ...user })), update: jest.fn(async () => ({})) },
  };
  const passwords = { verify: jest.fn(async () => false), dummyVerify: jest.fn(async () => undefined), needsRehash: () => false };
  const svc = new AuthService(prisma as never, passwords as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  return { svc, prisma, passwords };
}

describe('AuthService.login failed-login counting', () => {
  beforeEach(() => record.mockReset());

  it('counts a wrong password with the atomic counter, against the users table', async () => {
    const { svc, prisma } = setup();
    record.mockResolvedValue({ failedLogins: 1, lockedUntil: null, justLocked: false });
    await expect(svc.login(USER.email, 'wrong')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(record).toHaveBeenCalledWith(prisma, 'users', 'user-1');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('does not count a login refused because the hash queue is full: a busy server is not a wrong password', async () => {
    const { svc, prisma, passwords } = setup();
    passwords.verify.mockRejectedValue(new HashBusyError());
    const err = await svc.login(USER.email, 'right-or-wrong').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HashBusyError);
    expect((err as HashBusyError).getStatus()).toBe(503);
    expect(record).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses a locked account before hashing, as before', async () => {
    const { svc, passwords } = setup({ lockedUntil: new Date(Date.now() + 60_000) });
    await expect(svc.login(USER.email, 'pw')).rejects.toBeInstanceOf(ForbiddenException);
    expect(passwords.verify).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
