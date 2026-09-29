import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { KycTier, TxStatus, TxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Decimal, ZERO, dec, str } from '../common/money';

/**
 * Lagos is UTC+1 all year — no daylight saving to get wrong.
 *
 * "Daily" has to mean midnight to midnight where the customer lives. A rolling
 * 24 hours would be easier and would surprise somebody who moved ₦400,000 at
 * 11pm and cannot move ₦200,000 at 9am the next morning.
 */
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

export interface LimitCheck {
  allowed: boolean;
  reason?: string;
  singleLimit: Decimal;
  dailyLimit: Decimal;
  usedToday: Decimal;
  remainingToday: Decimal;
}

/**
 * How much real money a verified identity may move in a day.
 *
 * Naira only. A tier caps the leg that touches a bank, because that is what
 * identity verification is for — a coin moving between two wallets we control
 * moves no real money and is governed by the trade limits instead.
 */
@Injectable()
export class KycLimitsService {
  private readonly log = new Logger(KycLimitsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** ₦20,000, not ₦20000.00. A limit is read by a person, not parsed. */
  private naira(value: Decimal): string {
    return '₦' + Number(value.toFixed(2)).toLocaleString('en-NG', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
  }

  /** Midnight in Lagos, expressed as the UTC instant it happened. */
  private startOfDay(now = new Date()): Date {
    const lagos = new Date(now.getTime() + LAGOS_OFFSET_MS);
    const midnight = Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate());
    return new Date(midnight - LAGOS_OFFSET_MS);
  }

  async limitsFor(tier: KycTier) {
    const row = await this.prisma.kycTierLimit.findUnique({ where: { tier } });
    return {
      depositSingle: dec(row?.ngnDepositSingle ?? 0),
      depositDaily: dec(row?.ngnDepositDaily ?? 0),
      withdrawSingle: dec(row?.ngnWithdrawSingle ?? 0),
      withdrawDaily: dec(row?.ngnWithdrawDaily ?? 0),
    };
  }

  /**
   * Naira already moved today, in one direction.
   *
   * Counts COMPLETED and everything still in flight. A pending withdrawal has
   * not landed but the money is committed, and letting a second one through
   * because the first has not settled is how a daily cap is walked past.
   */
  private async usedToday(
    userId: string,
    direction: 'deposit' | 'withdraw',
    now = new Date(),
    /**
     * One transaction to leave out of the total.
     *
     * For re-asking "would this held deposit be allowed if I released it now?".
     * A held deposit already counts towards today's usage, so without this the
     * amount would be counted twice — once in the total and once as the amount
     * being tested — and a deposit well inside the cap would report as over it.
     */
    excludeTransactionId?: string,
  ): Promise<Decimal> {
    const since = this.startOfDay(now);
    const where = {
      userId,
      createdAt: { gte: since },
      status: {
        in: [TxStatus.COMPLETED, TxStatus.PENDING, TxStatus.PROCESSING, TxStatus.ON_HOLD],
      },
      ...(direction === 'deposit'
        ? { type: TxType.DEPOSIT, toAsset: 'ngn' }
        : { type: TxType.WITHDRAWAL, fromAsset: 'ngn' }),
      ...(excludeTransactionId ? { NOT: { id: excludeTransactionId } } : {}),
    };

    // Summed separately rather than through a computed key, because the two
    // branches return different shapes and narrowing a union of _sum results
    // costs more than writing the query twice.
    if (direction === 'deposit') {
      const r = await this.prisma.transaction.aggregate({ where, _sum: { toAmount: true } });
      return r._sum.toAmount ? dec(r._sum.toAmount) : ZERO;
    }
    const r = await this.prisma.transaction.aggregate({ where, _sum: { fromAmount: true } });
    return r._sum.fromAmount ? dec(r._sum.fromAmount) : ZERO;
  }

  /**
   * May this user move this much naira right now?
   *
   * A zero limit means the tier cannot do it at all, which reads differently
   * from being over a cap and deserves its own sentence.
   */
  async check(
    userId: string,
    tier: KycTier,
    direction: 'deposit' | 'withdraw',
    amount: Decimal,
    now = new Date(),
    /** Left out of today's total — see usedToday. */
    excludeTransactionId?: string,
  ): Promise<LimitCheck> {
    const limits = await this.limitsFor(tier);
    const single = direction === 'deposit' ? limits.depositSingle : limits.withdrawSingle;
    const daily = direction === 'deposit' ? limits.depositDaily : limits.withdrawDaily;
    const used = await this.usedToday(userId, direction, now, excludeTransactionId);
    const remaining = daily.minus(used);

    const base = { singleLimit: single, dailyLimit: daily, usedToday: used, remainingToday: remaining };
    const verb = direction === 'deposit' ? 'deposit' : 'withdraw';

    if (single.lte(0) && daily.lte(0)) {
      return {
        ...base,
        allowed: false,
        reason: `Your account cannot ${verb} naira yet. Complete the next verification tier to unlock it.`,
      };
    }

    if (amount.gt(single)) {
      return {
        ...base,
        allowed: false,
        reason: `The most you can ${verb} in one go is ${this.naira(single)}. Verify a higher tier to raise it.`,
      };
    }

    if (used.plus(amount).gt(daily)) {
      return {
        ...base,
        allowed: false,
        reason:
          remaining.lte(0)
            ? `You have used your ${this.naira(daily)} daily ${verb} limit. It resets at midnight.`
            : `That would take you past your ${this.naira(daily)} daily ${verb} limit. You have ${this.naira(remaining)} left today.`,
      };
    }

    return { ...base, allowed: true };
  }

  /** The same check, as a guard. Used where the answer is simply yes or no. */
  async assert(
    userId: string,
    tier: KycTier,
    direction: 'deposit' | 'withdraw',
    amount: Decimal,
  ): Promise<void> {
    const result = await this.check(userId, tier, direction, amount);
    if (!result.allowed) throw new BadRequestException(result.reason);
  }

  /** Every tier's naira limits, for the admin screen and the app. */
  async all() {
    const rows = await this.prisma.kycTierLimit.findMany({ orderBy: { tier: 'asc' } });
    return rows.map((r) => ({
      tier: r.tier,
      canTrade: r.canTrade,
      canWithdrawCrypto: r.canWithdrawCrypto,
      canWithdrawFiat: r.canWithdrawFiat,
      ngnDepositSingle: dec(r.ngnDepositSingle).toFixed(2),
      ngnDepositDaily: dec(r.ngnDepositDaily).toFixed(2),
      ngnWithdrawSingle: dec(r.ngnWithdrawSingle).toFixed(2),
      ngnWithdrawDaily: dec(r.ngnWithdrawDaily).toFixed(2),
      updatedAt: r.updatedAt,
      updatedBy: r.updatedBy,
    }));
  }

  /**
   * Set the naira limits for one tier.
   *
   * A daily limit below the single limit is refused: it would let somebody pass
   * the per-transaction check and fail the daily one every time, which reads as
   * a broken product rather than a policy.
   */
  async setLimits(
    tier: KycTier,
    input: {
      ngnDepositSingle: string;
      ngnDepositDaily: string;
      ngnWithdrawSingle: string;
      ngnWithdrawDaily: string;
    },
    updatedBy: string,
  ) {
    const values = {
      ngnDepositSingle: dec(input.ngnDepositSingle),
      ngnDepositDaily: dec(input.ngnDepositDaily),
      ngnWithdrawSingle: dec(input.ngnWithdrawSingle),
      ngnWithdrawDaily: dec(input.ngnWithdrawDaily),
    };

    for (const [field, value] of Object.entries(values)) {
      if (value.lt(0)) throw new BadRequestException(`${field} cannot be negative`);
    }
    if (values.ngnDepositDaily.gt(0) && values.ngnDepositDaily.lt(values.ngnDepositSingle)) {
      throw new BadRequestException(
        'The daily deposit limit is below the single-transaction limit, so no deposit of that size could ever succeed',
      );
    }
    if (values.ngnWithdrawDaily.gt(0) && values.ngnWithdrawDaily.lt(values.ngnWithdrawSingle)) {
      throw new BadRequestException(
        'The daily withdrawal limit is below the single-transaction limit, so no withdrawal of that size could ever succeed',
      );
    }

    await this.prisma.kycTierLimit.upsert({
      where: { tier },
      create: {
        tier,
        maxTradeUsd: 0,
        maxDailyTradeUsd: 0,
        maxDailyWithdrawUsd: 0,
        ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.toFixed()])),
        updatedBy,
      },
      update: {
        ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.toFixed()])),
        updatedBy,
      },
    });

    this.log.warn(
      `KYC naira limits for ${tier} set by ${updatedBy}: ` +
        `deposit ${input.ngnDepositSingle}/${input.ngnDepositDaily}, ` +
        `withdraw ${input.ngnWithdrawSingle}/${input.ngnWithdrawDaily}`,
    );
    return this.all();
  }
}
