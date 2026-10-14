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
