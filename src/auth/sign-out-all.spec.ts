import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';

/** Emergency "sign out all customers" (spec 2026-10-26 §3): older access tokens are refused at once. */
const SECRET = 'x'.repeat(40);
const jwt = new JwtService({});
const ctxFor = (token: string) =>
  ({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: `Bearer ${token}` } }) }),
  }) as never;

function guard(cutoffSec: number | null) {
  const config = { getOrThrow: () => SECRET, get: () => undefined };
  const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
  const settings = { customerSessionsValidAfterSec: () => cutoffSec };
  return new JwtAuthGuard(jwt, config as never, reflector, settings as never);
}
const token = (iat: number) => jwt.sign({ sub: 'u1', typ: 'access', iat }, { secret: SECRET, expiresIn: '15m' });
const now = () => Math.floor(Date.now() / 1000);

describe('JwtAuthGuard and "sign out all customers"', () => {
  it('nobody pressed it: a valid token works', async () => {
    await expect(guard(null).canActivate(ctxFor(token(now())))).resolves.toBe(true);
  });

  it('a token issued before the sign-out is refused, though it has not expired', async () => {
    const cut = now();
    const e = await guard(cut).canActivate(ctxFor(token(cut - 60))).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UnauthorizedException);
    expect((e as UnauthorizedException).message).toBe('Session expired. Please sign in again.');
  });

  it('a token issued in the very second of the sign-out is refused too', async () => {
    const cut = now();
    await expect(guard(cut).canActivate(ctxFor(token(cut)))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a token from a new sign-in afterwards works', async () => {
    const cut = now() - 120;
    await expect(guard(cut).canActivate(ctxFor(token(now())))).resolves.toBe(true);
  });
});
