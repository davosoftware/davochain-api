import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { KycStatus, KycTier, PolicyAction, PolicyLevel, UserStatus } from '@prisma/client';
import { KycGuard } from '../auth/jwt-auth.guard';
import { REQUIRED_ACTION_KEY } from './requires-action.decorator';

function guard(user: Record<string, unknown>, rules: Array<{ level: PolicyLevel; action: PolicyAction; allowed: boolean }>, action: string, body: Record<string, unknown> = {}) {
  const reflector = { getAllAndOverride: (key: string) => (key === REQUIRED_ACTION_KEY ? action : undefined) } as unknown as Reflector;
  const prisma = {
    user: { findUnique: jest.fn(async () => user) },
    rateQuote: { findFirst: jest.fn(async ({ where }: { where: { id: string } }) => (where.id === 'q-sell' ? { side: 'SELL' } : null)) },
  };
  const policy = {
    rulesFor: jest.fn(async (level: PolicyLevel) => rules.filter((r) => r.level === level)),
    allRules: jest.fn(async () => rules),
  };
  const g = new KycGuard(reflector, prisma as never, policy as never, { get: () => true } as never);
  const ctx = { getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => ({ user: { sub: 'u1' }, body }) }) } as never;
  return () => g.canActivate(ctx);
}
const basicUser = { status: UserStatus.ACTIVE, kycTier: KycTier.TIER_1, kycStatus: KycStatus.APPROVED, amlStatus: 'CLEAR', emailVerifiedAt: new Date() };
const noneUser = { status: UserStatus.ACTIVE, kycTier: KycTier.TIER_0, kycStatus: KycStatus.NOT_STARTED, amlStatus: 'NOT_SCREENED', emailVerifiedAt: new Date() };
const allow = (level: PolicyLevel, action: PolicyAction) => ({ level, action, allowed: true });

describe('@RequiresAction: the admin rules decide', () => {
  it('Basic allowed: passes', async () => {
    await expect(guard(basicUser, [allow(PolicyLevel.BASIC, PolicyAction.GIFTCARD_SELL)], 'GIFTCARD_SELL')()).resolves.toBe(true);
  });

  it('not allowed at the level: 403 NOT_ALLOWED_AT_LEVEL with the lowest level that allows it, and the old requiredTier', async () => {
    const err = await guard(basicUser, [allow(PolicyLevel.ADVANCED, PolicyAction.GIFTCARD_SELL)], 'GIFTCARD_SELL')().catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({
      code: 'NOT_ALLOWED_AT_LEVEL', action: 'GIFTCARD_SELL', currentLevel: 'BASIC', requiredLevel: 'ADVANCED', requiredTier: 'TIER_3',
      message: 'Complete Advanced verification to sell gift cards.',
    });
  });

  it('an action an admin opened to unverified people passes for them', async () => {
    await expect(guard(noneUser, [allow(PolicyLevel.NONE, PolicyAction.CRYPTO_DEPOSIT)], 'CRYPTO_DEPOSIT')()).resolves.toBe(true);
  });

  it('Advanced (in progress) gets Basic\'s rules', async () => {
    const tier2 = { ...basicUser, kycTier: KycTier.TIER_2 };
    await expect(guard(tier2, [allow(PolicyLevel.BASIC, PolicyAction.BUY)], 'BUY')()).resolves.toBe(true);
    await expect(guard(tier2, [allow(PolicyLevel.ADVANCED, PolicyAction.BUY)], 'BUY')()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a quote route decides by its side: sell needs SELL', async () => {
    await expect(guard(basicUser, [allow(PolicyLevel.BASIC, PolicyAction.BUY)], 'QUOTE_SIDE', { side: 'sell' })()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard(basicUser, [allow(PolicyLevel.BASIC, PolicyAction.SELL)], 'QUOTE_SIDE', { side: 'sell' })()).resolves.toBe(true);
  });

  it('carrying out a trade decides by the side of the stored quote (the body has only quoteId)', async () => {
    await expect(guard(basicUser, [allow(PolicyLevel.BASIC, PolicyAction.SELL)], 'QUOTE_SIDE', { quoteId: 'q-sell' })()).resolves.toBe(true);
    await expect(guard(basicUser, [allow(PolicyLevel.BASIC, PolicyAction.BUY)], 'QUOTE_SIDE', { quoteId: 'q-sell' })()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('an account under review is still refused with the review message, whatever the rules say', async () => {
    const review = { ...basicUser, amlStatus: 'UNDER_REVIEW' };
    const err = await guard(review, [allow(PolicyLevel.BASIC, PolicyAction.BUY)], 'BUY')().catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'ACCOUNT_UNDER_REVIEW' });
  });

  it('nobody allowed at any level: requiredLevel null', async () => {
    const err = await guard(basicUser, [], 'BUY')().catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'NOT_ALLOWED_AT_LEVEL', requiredLevel: null });
  });
});
