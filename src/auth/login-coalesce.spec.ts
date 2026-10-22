import { UnauthorizedException } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { AuthService } from './auth.service';
import { recordFailedLogin } from './failed-logins';

jest.mock('./failed-logins', () => ({ ...jest.requireActual('./failed-logins'), recordFailedLogin: jest.fn() }));
const record = recordFailedLogin as jest.MockedFunction<typeof recordFailedLogin>;

/**
 * Racing logins (launch request, 22 Oct 2026): an app that fires the same
 * sign-in several times at once (a double tap, a retry on a slow network)
 * gets ONE password check and ONE session, shared by every copy. Different
 * passwords, devices or networks are never merged.
 */
const tick = () => new Promise((r) => setImmediate(r));
const USER = { id: 'user-1', email: 'ada@davochain.test', passwordHash: 'scrypt$stored', status: UserStatus.ACTIVE, failedLogins: 0, lockedUntil: null };

function setup(right = 'right-pw') {
  const prisma = { user: { findUnique: jest.fn(async () => (await tick(), { ...USER })), update: jest.fn(async () => ({})) } };
  const passwords = {
    verify: jest.fn(async (pw: string) => (await tick(), await tick(), pw === right)),
    dummyVerify: jest.fn(async () => undefined),
    needsRehash: () => false,
  };
  const svc = new AuthService(prisma as never, passwords as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  let n = 0;
  const issue = jest
    .spyOn(svc as unknown as { issueTokens: () => Promise<unknown> }, 'issueTokens')
    .mockImplementation(async () => (await tick(), { accessToken: `a${++n}`, refreshToken: `r${n}` }));
  return { svc, passwords, issue };
}

const ctx = { ip: '1.2.3.4', userAgent: 'app/1.0' };

describe('AuthService.login: racing identical logins share one check and one session', () => {
  beforeEach(() => record.mockReset());

  it('5 identical logins at once: one password check, one session, the same tokens for all', async () => {
    const { svc, passwords, issue } = setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => svc.login('Ada@davochain.test ', 'right-pw', ctx)));
    expect(passwords.verify).toHaveBeenCalledTimes(1);
    expect(issue).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.refreshToken)).size).toBe(1);
  });

  it('a wrong password raced 5 times is checked once and counted once; every copy gets the 401', async () => {
    const { svc, passwords } = setup();
    record.mockResolvedValue({ failedLogins: 1, lockedUntil: null, justLocked: false });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => svc.login(USER.email, 'wrong', ctx)));
    expect(results.every((r) => r.status === 'rejected' && r.reason instanceof UnauthorizedException)).toBe(true);
    expect(passwords.verify).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('different passwords are never merged', async () => {
    const { svc, passwords } = setup();
    record.mockResolvedValue({ failedLogins: 1, lockedUntil: null, justLocked: false });
    await Promise.allSettled([svc.login(USER.email, 'right-pw', ctx), svc.login(USER.email, 'wrong', ctx)]);
    expect(passwords.verify).toHaveBeenCalledTimes(2);
  });

  it('different devices or networks get their own sessions', async () => {
    const { svc, issue } = setup();
    await Promise.all([svc.login(USER.email, 'right-pw', ctx), svc.login(USER.email, 'right-pw', { ip: '5.6.7.8', userAgent: 'app/1.0' }), svc.login(USER.email, 'right-pw', { ip: '1.2.3.4', userAgent: 'web' })]);
    expect(issue).toHaveBeenCalledTimes(3);
  });

  it('once finished, the next login is a new one (nothing is cached)', async () => {
    const { svc, passwords, issue } = setup();
    const a = await svc.login(USER.email, 'right-pw', ctx);
    const b = await svc.login(USER.email, 'right-pw', ctx);
    expect(passwords.verify).toHaveBeenCalledTimes(2);
    expect(issue).toHaveBeenCalledTimes(2);
    expect(a.refreshToken).not.toBe(b.refreshToken);
  });
});
