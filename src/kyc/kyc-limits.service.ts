import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { KycTier, PolicyAction, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Decimal, dec } from '../common/money';
import { Fx, LevelPolicyService, Verdict } from '../levels/level-policy.service';
import { levelOf } from '../levels/levels';

export interface LimitCheck {
  allowed: boolean;
  reason?: string;
  /** null = no limit set by an admin. */
  singleLimit: Decimal | null;
  dailyLimit: Decimal | null;
  usedToday: Decimal;
  remainingToday: Decimal | null;
  currency: 'NGN' | 'USD';
}

/**
 * How much naira a person may move in a day: the NGN_DEPOSIT and NGN_WITHDRAW
 * rows of the admin's level rules (level policy spec §5.3). Kept as its own
 * service so the deposit, withdrawal and review code keep asking one question.
 */
@Injectable()
export class KycLimitsService {
  private readonly log = new Logger(KycLimitsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: LevelPolicyService,
  ) {}

  /** The ₦/$ rate for checkInTransaction, fetched before the write that locks money. */
  fx(): Promise<Fx> {
    return this.policy.fx();
  }

  /** Fetches the ₦/$ rate itself, so never call it inside a write. */
  async check(
    userId: string,
    tier: KycTier,
    direction: 'deposit' | 'withdraw',
    amount: Decimal,
    now = new Date(),
    /**
     * Left out of today's total: re-asking "would this held deposit fit if
     * released now?" must not count its own amount twice.
     */
    excludeTransactionId?: string,
  ): Promise<LimitCheck> {
    const fx = await this.policy.fx();
    return this.toCheck(
      await this.policy.evaluate(this.prisma, userId, levelOf(tier), this.action(direction), amount, 'NGN', fx, { now, excludeTransactionId }),
    );
  }

  /** Recheck inside the serializable write that locks the money; fx was fetched before it. */
  async checkInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    tier: KycTier,
    direction: 'deposit' | 'withdraw',
    amount: Decimal,
    fx: Fx,
    now = new Date(),
  ): Promise<LimitCheck> {
    return this.toCheck(await this.policy.evaluate(tx, userId, levelOf(tier), this.action(direction), amount, 'NGN', fx, { now }));
  }

  private action(direction: 'deposit' | 'withdraw'): PolicyAction {
    return direction === 'deposit' ? PolicyAction.NGN_DEPOSIT : PolicyAction.NGN_WITHDRAW;
  }

  private toCheck(v: Verdict): LimitCheck {
    return {
      allowed: v.allowed,
      reason: v.reason,
      singleLimit: v.maxPerTx,
      dailyLimit: v.maxPerDay,
      usedToday: v.usedToday,
      remainingToday: v.remainingToday,
      currency: v.currency,
    };
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
