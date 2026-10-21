import { Injectable } from '@nestjs/common';
import { KycStatus, KycTier } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KycLimitsService } from './kyc-limits.service';
import { ZERO, type Decimal } from '../common/money';
import { BasicVerificationService } from './basic-verification.service';
import { AdvancedVerificationService } from './advanced/advanced-verification.service';

/** The level as the app reads it. TIER_2 is "Advanced (in progress)": ID and selfie done, address not yet. */
const LEVEL_KEYS: Record<KycTier, 'NONE' | 'BASIC' | 'ADVANCED_IN_PROGRESS' | 'ADVANCED'> = {
  TIER_0: 'NONE',
  TIER_1: 'BASIC',
  TIER_2: 'ADVANCED_IN_PROGRESS',
  TIER_3: 'ADVANCED',
};

/**
 * Raw BVN and NIN values are NEVER stored. Only a hash for matching plus the
 * last four digits so support can confirm against them — the provider keeps
 * the real value. A breach of this table must not be a breach of identity data.
 */
@Injectable()
export class KycService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: KycLimitsService,
    private readonly basic: BasicVerificationService,
    private readonly advancedChecks: AdvancedVerificationService,
  ) {}

  /**
   * Where this user stands, and what a tier is worth.
   *
   * Only NAIRA limits are reported, because naira is the only thing a tier
   * actually caps. The columns for dollar trade caps and capability flags are
   * not enforced anywhere — the real trade ceiling comes from RateConfig and
   * trading is gated by the KYC guard — so returning them told an app about
   * limits that nothing honoured, which is worse than saying nothing.
   */
  async status(userId: string) {
    const [profile, tiers, latest, attempts, advanced] = await Promise.all([
      this.prisma.kycProfile.findUnique({
        where: { userId },
        include: { documents: { select: { type: true, status: true, uploadedAt: true } } },
      }),
      this.prisma.kycTierLimit.findMany({ orderBy: { tier: 'asc' } }),
      this.prisma.kycVerification.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { state: true } }),
      this.basic.attemptsLeft(userId),
      this.advancedChecks.summary(userId),
    ]);

    const tier = profile?.tier ?? KycTier.TIER_0;

    // What they can do right now, today — the figure a screen actually shows,
    // rather than making every client re-derive it from a table of tiers.
    const [deposit, withdraw] = await Promise.all([
      this.limits.check(userId, tier, 'deposit', ZERO),
      this.limits.check(userId, tier, 'withdraw', ZERO),
    ]);

    // null = no limit set. The figures are in the rule's currency (naira unless an admin chose dollars).
    const spend = (c: { singleLimit: Decimal | null; dailyLimit: Decimal | null; usedToday: Decimal; remainingToday: Decimal | null; currency: 'NGN' | 'USD' }) => ({
      singleNgn: c.singleLimit ? c.singleLimit.toFixed(2) : null,
      dailyNgn: c.dailyLimit ? c.dailyLimit.toFixed(2) : null,
      usedTodayNgn: c.usedToday.toFixed(2),
      remainingTodayNgn: c.remainingToday ? (c.remainingToday.lt(0) ? ZERO : c.remainingToday).toFixed(2) : null,
      currency: c.currency,
    });

    return {
      tier,
      status: profile?.status ?? KycStatus.NOT_STARTED,
      rejectionReason: profile?.rejectionReason ?? null,
      submittedAt: profile?.submittedAt ?? null,
      bvnLast4: profile?.bvnLast4 ?? null,
      documents: profile?.documents ?? [],

      /** Basic verification (spec §11). */
      level: LEVEL_KEYS[tier],
      basicState: latest?.state ?? null,
      /** Generic on purpose: never says why (no tipping off). */
      underReview: latest ? ['LOOKED_UP', 'IDENTITY_REVIEW', 'COMPLIANCE_REVIEW'].includes(latest.state) : false,
      attemptsLeftToday: attempts.today,
      attemptsLeftTotal: attempts.total,

      /** Advanced (spec 2026-10-21 §4): each step's state, a reason the customer can act on, attempts left. */
      advanced,

      /** Naira only. Nothing else is capped by tier. */
      limits: {
        /** This user, this tier, today. Resets at midnight in Lagos. */
        current: { deposit: spend(deposit), withdraw: spend(withdraw) },
        /** Every tier, so an app can show what verifying further unlocks. */
        tiers: tiers.map((l) => ({
          tier: l.tier,
          depositSingleNgn: l.ngnDepositSingle.toString(),
          depositDailyNgn: l.ngnDepositDaily.toString(),
          withdrawSingleNgn: l.ngnWithdrawSingle.toString(),
          withdrawDailyNgn: l.ngnWithdrawDaily.toString(),
        })),
      },
    };
  }
}
