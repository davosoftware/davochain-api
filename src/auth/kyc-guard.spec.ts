import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';
import { KycGuard, REQUIRED_TIER_KEY, GATE_REVIEW, GATE_PENDING, GATE_VERIFY } from './jwt-auth.guard';

function ctx(user: object | undefined, required: string | null = 'TIER_1') {
  const handler = () => undefined;
  if (required) Reflect.defineMetadata(REQUIRED_TIER_KEY, required, handler);
  return { getHandler: () => handler, getClass: () => class {}, switchToHttp: () => ({ getRequest: () => ({ user }) }) } as never;
}
function guard(row: object | null) {
  const prisma = { user: { findUnique: jest.fn(async () => row) } };
  return { g: new KycGuard(new Reflector(), prisma as never), prisma };
}
// A token that CLAIMS approval: the guard must not believe it (review focus 5).
const token = { sub: 'u1', kyc: 'APPROVED', tier: 'TIER_1' };
const ok = { status: 'ACTIVE', kycTier: 'TIER_1', kycStatus: 'APPROVED', amlStatus: 'CLEAR' };

describe('KycGuard reads the database (spec §7.3)', () => {
  it('allows an approved, CLEAR, active user', async () => expect(await guard(ok).g.canActivate(ctx(token))).toBe(true));

  it.each([
    [{ ...ok, amlStatus: 'BLOCKED' }, GATE_REVIEW],
    [{ ...ok, amlStatus: 'RESTRICTED' }, GATE_REVIEW],
    [{ ...ok, amlStatus: 'UNDER_REVIEW' }, GATE_REVIEW],
    [{ ...ok, status: 'SUSPENDED' }, GATE_REVIEW],
    [{ ...ok, amlStatus: 'PENDING' }, GATE_PENDING],
    [{ ...ok, amlStatus: 'NOT_SCREENED' }, GATE_VERIFY],
    [{ ...ok, kycStatus: 'PENDING' }, GATE_VERIFY],
    [{ ...ok, kycTier: 'TIER_0' }, GATE_VERIFY],
  ])('refuses %o even with a stale approved token', async (row, message) => {
    const err = await guard(row).g.canActivate(ctx(token)).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toBe(message);
  });

  it('the verify refusal keeps the fields the app opens the verification screen on, from the database', async () => {
    const err = await guard({ ...ok, kycTier: 'TIER_0', kycStatus: 'NOT_STARTED' }).g.canActivate(ctx(token)).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ requiredTier: 'TIER_1', currentTier: 'TIER_0', kycStatus: 'NOT_STARTED' });
  });

  it('under review carries a generic code and never says why', async () => {
    const err = await guard({ ...ok, amlStatus: 'BLOCKED' }).g.canActivate(ctx(token)).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'ACCOUNT_UNDER_REVIEW' });
    expect(JSON.stringify(err.getResponse())).not.toMatch(/sanction|pep|aml|blocked/i);
  });

  it('routes without @RequiresKyc never touch the database', async () => {
    const { g, prisma } = guard(ok);
    expect(await g.canActivate(ctx(token, null))).toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
