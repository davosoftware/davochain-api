import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { KycTier, PolicyAction, PolicyLevel } from '@prisma/client';
import { LevelPolicyService } from './level-policy.service';
import { dec } from '../common/money';

const FX = { ngnPerUsd: dec('1500') };
const NOW = new Date('2026-10-15T10:00:00Z');

function rule(over: Record<string, unknown>) {
  return { level: PolicyLevel.BASIC, action: PolicyAction.GIFTCARD_SELL, allowed: true, currency: 'NGN', minPerTx: null, maxPerTx: null, maxPerDay: null, ...over };
}

function build(rules: ReturnType<typeof rule>[], used: { tx?: string; giftNgn?: string; platform?: string } = {}) {
  const db = {
    levelRule: {
      findMany: jest.fn(async ({ where }: { where: { level?: string; action?: string } }) =>
        rules.filter((r) => (!where?.level || r.level === where.level) && (!where?.action || r.action === where.action))),
    },
    transaction: {
      aggregate: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        ({ _sum: { usdValue: dec('userId' in where ? used.tx ?? '0' : used.platform ?? '0'), toAmount: dec(used.tx ?? '0') } })),
    },
    giftCardTrade: { aggregate: jest.fn(async () => ({ _sum: { expectedNgn: dec(used.giftNgn ?? '0') } })) },
    platformLimit: { findUnique: jest.fn(async () => ({ tradingMaxPerDay: dec('50000'), currency: 'USD' })) },
  };
  const levelCooloff = { findUnique: jest.fn(async () => ({ afterSignupHours: 24, afterCredentialChangeHours: 48, afterNewPayeeHours: 0 })) };
  const rates = { price: jest.fn(async () => ({ ngnPerUsd: dec('1500') })) };
  const svc = new LevelPolicyService({ ...db, levelCooloff } as never, rates as never);
  return { svc, db, rates };
}

describe('LevelPolicyService.evaluate', () => {
  it('a missing rule is not allowed', async () => {
    const { svc, db } = build([]);
    const v = await svc.evaluate(db as never, 'u1', PolicyLevel.BASIC, PolicyAction.GIFTCARD_SELL, dec('1000'), 'NGN', FX, { now: NOW });
    expect(v.allowed).toBe(false);
  });

  it('a rule switched off is not allowed', async () => {
    const { svc, db } = build([rule({ allowed: false })]);
    expect((await svc.evaluate(db as never, 'u1', PolicyLevel.BASIC, PolicyAction.GIFTCARD_SELL, dec('1'), 'NGN', FX, { now: NOW })).allowed).toBe(false);
  });

  it('another action\'s rule is never used', async () => {
    const { svc, db } = build([rule({ action: PolicyAction.BUY })]);
    expect((await svc.evaluate(db as never, 'u1', PolicyLevel.BASIC, PolicyAction.GIFTCARD_SELL, dec('1'), 'NGN', FX, { now: NOW })).allowed).toBe(false);
  });

  it('minimum, maximum per transaction and daily maximum, with plain reasons', async () => {
    const { svc, db } = build([rule({ minPerTx: dec('5000'), maxPerTx: dec('500000'), maxPerDay: dec('1000000') })], { giftNgn: '900000' });
    const check = (n: string) => svc.evaluate(db as never, 'u1', PolicyLevel.BASIC, PolicyAction.GIFTCARD_SELL, dec(n), 'NGN', FX, { now: NOW });
    expect((await check('1000')).reason).toBe('The smallest amount you can sell gift cards for is ₦5,000.');
    expect((await check('600000')).reason).toBe('The most you can sell gift cards for in one go is ₦500,000.');
    expect((await check('150000')).reason).toBe('That would take you past your ₦1,000,000 daily limit to sell gift cards. You have ₦100,000 left today.');
    expect((await check('100000')).allowed).toBe(true);
  });

  it('converts a naira amount to a dollar row with the rate fetched before the write', async () => {
    const { svc, db } = build([rule({ action: PolicyAction.GIFTCARD_SELL, currency: 'USD', maxPerTx: dec('100') })]);
    // ₦160,000 at ₦1,500/$ = $106.67 > $100.
    const v = await svc.evaluate(db as never, 'u1', PolicyLevel.BASIC, PolicyAction.GIFTCARD_SELL, dec('160000'), 'NGN', FX, { now: NOW });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('The most you can sell gift cards for in one go is $100.00.');
  });

  it('converts a dollar amount to a naira row (buy in a ₦ row)', async () => {
    const { svc, db } = build([rule({ action: PolicyAction.BUY, currency: 'NGN', maxPerTx: dec('1000000') })]);
    // $700 at ₦1,500 = ₦1,050,000 > ₦1,000,000.
    expect((await svc.evaluate(db as never, 'u1', PolicyLevel.BASIC, PolicyAction.BUY, dec('700'), 'USD', FX, { now: NOW })).allowed).toBe(false);
  });

  it('trading also respects the platform daily limit', async () => {
    const { svc, db } = build([rule({ action: PolicyAction.BUY, currency: 'USD' })], { platform: '49900' });
    const v = await svc.evaluate(db as never, 'u1', PolicyLevel.BASIC, PolicyAction.BUY, dec('200'), 'USD', FX, { now: NOW });
    expect(v.reason).toBe('Trading has reached its daily limit. Please try again tomorrow.');
  });

  it('assertWithinLimits throws 400 with the reason', async () => {
    const { svc, db } = build([rule({ maxPerTx: dec('1') })]);
    await expect(svc.assertWithinLimits(db as never, 'u1', PolicyLevel.BASIC, PolicyAction.GIFTCARD_SELL, dec('2'), 'NGN', FX, { now: NOW })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('LevelPolicyService.fx', () => {
  it('no exchange rate = refuse, never skip a limit', async () => {
    const { svc, rates } = build([]);
    rates.price.mockRejectedValueOnce(new Error('Quidax down'));
    await expect(svc.fx()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('LevelPolicyService.assertCooledOff', () => {
  const user = { id: 'u1', kycTier: KycTier.TIER_1, createdAt: new Date('2026-10-15T00:00:00Z'), credentialsChangedAt: null as Date | null };

  it('blocks withdrawals until 24 h after sign-up, saying when (Lagos time)', async () => {
    const { svc } = build([]);
    const err = await svc.assertCooledOff(user, PolicyAction.CRYPTO_WITHDRAW, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ code: 'COOLING_OFF', action: 'CRYPTO_WITHDRAW', until: '2026-10-16T00:00:00.000Z' });
    expect(err.message).toContain('01:00 on 16 October');
  });

  it('blocks withdrawals for 48 h after a password change', async () => {
    const { svc } = build([]);
    const old = { ...user, createdAt: new Date('2026-01-01T00:00:00Z'), credentialsChangedAt: new Date('2026-10-15T09:00:00Z') };
    await expect(svc.assertCooledOff(old, PolicyAction.NGN_WITHDRAW, NOW)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.assertCooledOff(old, PolicyAction.NGN_WITHDRAW, new Date('2026-10-17T09:00:01Z'))).resolves.toBeUndefined();
  });

  it('never applies to buying', async () => {
    const { svc } = build([]);
    await expect(svc.assertCooledOff(user, PolicyAction.BUY, NOW)).resolves.toBeUndefined();
  });
});
