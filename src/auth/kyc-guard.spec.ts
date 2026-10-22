import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';
import { KycGuard, REQUIRED_TIER_KEY, GATE_REVIEW, GATE_PENDING, GATE_VERIFY } from './jwt-auth.guard';
import { REQUIRED_ACTION_KEY, REQUIRED_EMAIL_KEY } from '../levels/requires-action.decorator';

function ctx(user: object | undefined, required: string | null = 'TIER_1') {
  const handler = () => undefined;
  if (required) Reflect.defineMetadata(REQUIRED_TIER_KEY, required, handler);
  return { getHandler: () => handler, getClass: () => class {}, switchToHttp: () => ({ getRequest: () => ({ user }) }) } as never;
}
function guard(row: object | null, required = true) {
  const prisma = { user: { findUnique: jest.fn(async () => row) } };
  const policy = { rulesFor: jest.fn(async () => [{ action: 'BUY', allowed: true }]), allRules: jest.fn(async () => []) };
  const config = { get: jest.fn(() => required) };
  return { g: new KycGuard(new Reflector(), prisma as never, policy as never, config as never), prisma, policy };
}
// A token that CLAIMS approval: the guard must not believe it (review focus 5).
const token = { sub: 'u1', kyc: 'APPROVED', tier: 'TIER_1' };
const ok = { status: 'ACTIVE', kycTier: 'TIER_1', kycStatus: 'APPROVED', amlStatus: 'CLEAR', emailVerifiedAt: new Date() };

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

/** H9 (plan 2026-10-22 Task 5): no money and no verification until the email is confirmed. */
function meta(key: string, value: unknown) {
  const handler = () => undefined;
  Reflect.defineMetadata(key, value, handler);
  return { getHandler: () => handler, getClass: () => class {}, switchToHttp: () => ({ getRequest: () => ({ user: token, body: {} }) }) } as never;
}
const unverified = { ...ok, emailVerifiedAt: null };

describe('KycGuard: confirm email before money (H9)', () => {
  it.each([
    ['@RequiresKyc', REQUIRED_TIER_KEY, 'TIER_1'],
    ['@RequiresAction', REQUIRED_ACTION_KEY, 'BUY'],
    ['@RequiresVerifiedEmail', REQUIRED_EMAIL_KEY, true],
  ])('%s refuses an unconfirmed email with EMAIL_NOT_VERIFIED, before the level check', async (_n, key, value) => {
    const { g, policy } = guard({ ...unverified, email: 'ada@example.com' });
    const err = await g.canActivate(meta(key, value)).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ statusCode: 403, code: 'EMAIL_NOT_VERIFIED' });
    expect(err.message).toBe('Confirm your email address first. We sent a code to a**@example.com.');
    expect(policy.rulesFor).not.toHaveBeenCalled();
  });

  it.each([
    ['@RequiresKyc', REQUIRED_TIER_KEY, 'TIER_1'],
    ['@RequiresAction', REQUIRED_ACTION_KEY, 'BUY'],
    ['@RequiresVerifiedEmail', REQUIRED_EMAIL_KEY, true],
  ])('%s lets a confirmed email through to the usual checks', async (_n, key, value) => {
    expect(await guard({ ...ok, email: 'ada@example.com' }).g.canActivate(meta(key, value))).toBe(true);
  });

  it('with EMAIL_VERIFICATION_REQUIRED=false an unconfirmed email passes (Review Focus 2)', async () => {
    expect(await guard({ ...unverified, email: 'ada@example.com' }, false).g.canActivate(meta(REQUIRED_EMAIL_KEY, true))).toBe(true);
    expect(await guard({ ...unverified, email: 'ada@example.com' }, false).g.canActivate(meta(REQUIRED_TIER_KEY, 'TIER_1'))).toBe(true);
  });

  it('@RequiresVerifiedEmail does not need a KYC level', async () => {
    const row = { ...ok, kycTier: 'TIER_0', kycStatus: 'NOT_STARTED', amlStatus: 'NOT_SCREENED', email: 'ada@example.com' };
    expect(await guard(row).g.canActivate(meta(REQUIRED_EMAIL_KEY, true))).toBe(true);
  });

  it('@RequiresVerifiedEmail still refuses a suspended account', async () => {
    const err = await guard({ ...ok, status: 'SUSPENDED', email: 'ada@example.com' }).g.canActivate(meta(REQUIRED_EMAIL_KEY, true)).catch((e) => e);
    expect(err.message).toBe(GATE_REVIEW);
  });

  it('routes with none of the three are untouched', async () => {
    const { g, prisma } = guard(unverified);
    expect(await g.canActivate(ctx(token, null))).toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
