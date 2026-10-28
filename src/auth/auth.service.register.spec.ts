import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthService } from './auth.service';

it('a phone already registered is refused like a taken email, never a 500 (phone is unique)', async () => {
  const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x', meta: { target: ['phone'] } });
  const prisma = { user: { findUnique: jest.fn(async () => null), create: jest.fn(async () => { throw p2002; }) } };
  const passwords = { hash: jest.fn(async () => 'hash') };
  const config = { get: () => 'test' };
  const svc = new AuthService(prisma as never, passwords as never, {} as never, {} as never, config as never, {} as never, {} as never, {} as never);
  await expect(svc.register({ email: 'a@b.test', password: 'x', firstName: 'A', lastName: 'B', phone: '+2348012345678' })).rejects.toEqual(
    new BadRequestException('Unable to register with those details'),
  );
});

it('sign-up never waits for the email code to send: a hung mail server cannot stall it (final review, Important 2)', async () => {
  const prisma = { user: { findUnique: jest.fn(async () => null), create: jest.fn(async () => ({ id: 'u1', email: 'a@b.test', firstName: 'A', lastName: 'B' })) } };
  const passwords = { hash: jest.fn(async () => 'hash') };
  const config = { get: () => 'test' };
  const provisioning = { add: jest.fn(async () => undefined) };
  const mail = { send: jest.fn(async () => undefined) };
  const otps = { requestForUser: jest.fn(() => new Promise(() => undefined)) }; // never settles
  const svc = new AuthService(prisma as never, passwords as never, provisioning as never, {} as never, config as never, mail as never, otps as never, {} as never);
  jest.spyOn(svc as unknown as { issueTokens: () => Promise<unknown> }, 'issueTokens').mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
  const done = svc.register({ email: 'a@b.test', password: 'x', firstName: 'A', lastName: 'B' });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('register waited for the email')), 500));
  await expect(Promise.race([done, timeout])).resolves.toMatchObject({ userId: 'u1', accessToken: 'a' });
  expect(otps.requestForUser).toHaveBeenCalledWith('u1', 'EMAIL_VERIFY');
});

it('every new customer gets a payment username, "firstname_digits", and a failure there never stops sign-up (28 Oct 2026)', async () => {
  const build = (assign: () => Promise<unknown>) => {
    const prisma = { user: { findUnique: jest.fn(async () => null), create: jest.fn(async () => ({ id: 'u1', email: 'a@b.test', firstName: 'Ada', lastName: 'B' })) } };
    const payUsernames = { assignGenerated: jest.fn(assign) };
    const svc = new AuthService(
      prisma as never, { hash: jest.fn(async () => 'hash') } as never, { add: jest.fn(async () => undefined) } as never, {} as never,
      { get: () => 'test' } as never, { send: jest.fn(async () => undefined) } as never, { requestForUser: jest.fn(async () => undefined) } as never, {} as never,
      undefined, payUsernames as never,
    );
    jest.spyOn(svc as unknown as { issueTokens: () => Promise<unknown> }, 'issueTokens').mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
    return { svc, payUsernames };
  };
  const ok = build(async () => 'ada_4821');
  await ok.svc.register({ email: 'a@b.test', password: 'x', firstName: 'Ada', lastName: 'B' });
  expect(ok.payUsernames.assignGenerated).toHaveBeenCalledWith('u1');

  const broken = build(async () => { throw new Error('db hiccup'); });
  await expect(broken.svc.register({ email: 'a@b.test', password: 'x', firstName: 'Ada', lastName: 'B' })).resolves.toMatchObject({ userId: 'u1' });
});
