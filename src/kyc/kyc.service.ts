import { BadRequestException, Injectable } from '@nestjs/common';
import { KycStatus, KycTier } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { KycLimitsService } from './kyc-limits.service';
import { ZERO, type Decimal } from '../common/money';
import { TemplatedMailService } from '../cms/templated-mail.service';

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
    private readonly mail: TemplatedMailService,
  ) {}

  private digest(value: string): string {
    return createHash('sha256').update(value.trim()).digest('hex');
  }

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
    const [profile, tiers] = await Promise.all([
      this.prisma.kycProfile.findUnique({
        where: { userId },
        include: { documents: { select: { type: true, status: true, uploadedAt: true } } },
      }),
      this.prisma.kycTierLimit.findMany({ orderBy: { tier: 'asc' } }),
    ]);

    const tier = profile?.tier ?? KycTier.TIER_0;

    // What they can do right now, today — the figure a screen actually shows,
    // rather than making every client re-derive it from a table of tiers.
    const [deposit, withdraw] = await Promise.all([
      this.limits.check(userId, tier, 'deposit', ZERO),
      this.limits.check(userId, tier, 'withdraw', ZERO),
    ]);

    const spend = (c: { singleLimit: Decimal; dailyLimit: Decimal; usedToday: Decimal; remainingToday: Decimal }) => ({
      singleNgn: c.singleLimit.toFixed(2),
      dailyNgn: c.dailyLimit.toFixed(2),
      usedTodayNgn: c.usedToday.toFixed(2),
      remainingTodayNgn: (c.remainingToday.lt(0) ? ZERO : c.remainingToday).toFixed(2),
    });

    return {
      tier,
      status: profile?.status ?? KycStatus.NOT_STARTED,
      rejectionReason: profile?.rejectionReason ?? null,
      submittedAt: profile?.submittedAt ?? null,
      bvnLast4: profile?.bvnLast4 ?? null,
      documents: profile?.documents ?? [],

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

  async submitTier1(userId: string, input: { bvn?: string; nin?: string; dateOfBirth: string }) {
    if (!input.bvn && !input.nin) {
      throw new BadRequestException('Provide either a BVN or a NIN');
    }
    const id = input.bvn ?? input.nin!;
    if (!/^[0-9]{11}$/.test(id)) {
      throw new BadRequestException('BVN and NIN are 11 digits');
    }

    const profile = await this.prisma.kycProfile.upsert({
      where: { userId },
      create: {
        userId,
        status: KycStatus.PENDING,
        dateOfBirth: new Date(input.dateOfBirth),
        ...(input.bvn
          ? { bvnHash: this.digest(input.bvn), bvnLast4: input.bvn.slice(-4) }
          : { ninHash: this.digest(input.nin!), ninLast4: input.nin!.slice(-4) }),
        submittedAt: new Date(),
      },
      update: {
        status: KycStatus.PENDING,
        dateOfBirth: new Date(input.dateOfBirth),
        ...(input.bvn
          ? { bvnHash: this.digest(input.bvn), bvnLast4: input.bvn.slice(-4) }
          : { ninHash: this.digest(input.nin!), ninLast4: input.nin!.slice(-4) }),
        submittedAt: new Date(),
        rejectionReason: null,
      },
    });

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { kycStatus: KycStatus.PENDING },
      select: { email: true, firstName: true, lastName: true },
    });

    // Review is manual until a provider is chosen, so this is the only thing
    // that tells somebody their submission arrived rather than vanished.
    await this.mail.send({
      key: 'kyc.submitted',
      to: user.email,
      variables: {
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
      },
    });

    // TODO: hand off to a verification provider once chosen — see TODO.md.
    return { status: profile.status, submittedAt: profile.submittedAt };
  }

  async attachDocument(
    userId: string,
    input: { type: string; storageKey: string; mimeType: string; sizeBytes: number },
  ) {
    const profile = await this.prisma.kycProfile.findUniqueOrThrow({ where: { userId } });
    return this.prisma.kycDocument.create({
      data: {
        kycProfileId: profile.id,
        type: input.type as never,
        storageKey: input.storageKey,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
      },
      select: { id: true, type: true, status: true, uploadedAt: true },
    });
  }
}
