import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { GiftCardTradeStatus, KycTier, LevelRule, PolicyAction, PolicyLevel, Prisma, TxStatus, TxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RatesService } from '../rates/rates.service';
import { Decimal, ZERO, dec } from '../common/money';
import { formatLagos } from '../common/dates';
import { ACTIONS, levelOf } from './levels';

export type Db = Pick<Prisma.TransactionClient, 'levelRule' | 'transaction' | 'giftCardTrade' | 'platformLimit'>;
export interface Fx {
  ngnPerUsd: Decimal;
}
export interface Verdict {
  allowed: boolean;
  reason?: string;
  currency: 'NGN' | 'USD';
  minPerTx: Decimal | null;
  maxPerTx: Decimal | null;
  maxPerDay: Decimal | null;
  usedToday: Decimal;
  remainingToday: Decimal | null;
}

const HOUR = 3_600_000;
const TRADES: PolicyAction[] = [PolicyAction.BUY, PolicyAction.SELL, PolicyAction.SWAP];

/** Midnight in Lagos (UTC+1 all year, no daylight saving), as an instant. */
export function startOfLagosDay(now = new Date()): Date {
  const lagos = new Date(now.getTime() + HOUR);
  return new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate()) - HOUR);
}

/** ₦5,000 or $100.00: read by a person, not parsed. */
function money(v: Decimal, currency: 'NGN' | 'USD'): string {
  return currency === 'NGN'
    ? '₦' + Number(v.toFixed(2)).toLocaleString('en-NG', { maximumFractionDigits: 2 })
    : '$' + Number(v.toFixed(2)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * The one gatekeeper (level policy spec §5.1): may this person do this action,
 * for this amount, right now? Everything it knows comes from admin rules; a
 * rule that is missing means "not allowed", and nothing is ever skipped
 * because a price or a rule could not be read.
 */
@Injectable()
export class LevelPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rates: RatesService,
  ) {}

  /** The ₦/$ rate, fetched BEFORE a locked write (no network call inside one). */
  async fx(): Promise<Fx> {
    try {
      const p = await this.rates.price('ngn');
      return { ngnPerUsd: dec(p.ngnPerUsd) };
    } catch {
      throw new ServiceUnavailableException('Pricing is unavailable right now. Please try again shortly.');
    }
  }

  /** Always read fresh: a saved change applies to the very next request. */
  rulesFor(level: PolicyLevel, db: Pick<Db, 'levelRule'> = this.prisma): Promise<LevelRule[]> {
    return db.levelRule.findMany({ where: { level } });
  }

  allRules(): Promise<LevelRule[]> {
    return this.prisma.levelRule.findMany();
  }

  private convert(amount: Decimal, from: 'NGN' | 'USD', to: 'NGN' | 'USD', fx: Fx): Decimal {
    if (from === to) return amount;
    return from === 'USD' ? amount.mul(fx.ngnPerUsd) : amount.div(fx.ngnPerUsd);
  }

  /** Today's total for one action, in the action's natural unit (ACTIONS[action].unit). */
  private async usedToday(db: Db, userId: string, action: PolicyAction, now: Date, excludeTransactionId?: string): Promise<Decimal> {
    const since = startOfLagosDay(now);
    const notFailed = { not: TxStatus.FAILED };
    const exclude = excludeTransactionId ? { NOT: { id: excludeTransactionId } } : {};
    const sumUsd = async (where: Prisma.TransactionWhereInput) =>
      dec((await db.transaction.aggregate({ where, _sum: { usdValue: true } }))._sum.usdValue ?? 0);
    const sumNgn = async (where: Prisma.TransactionWhereInput) =>
      dec((await db.transaction.aggregate({ where, _sum: { toAmount: true } }))._sum.toAmount ?? 0);
    switch (action) {
      case PolicyAction.BUY:
        return sumUsd({ userId, type: TxType.BUY, status: notFailed, createdAt: { gte: since }, ...exclude });
      case PolicyAction.SELL:
        return sumUsd({ userId, type: TxType.SELL, status: notFailed, createdAt: { gte: since }, ...exclude });
      case PolicyAction.SWAP:
        return sumUsd({ userId, type: TxType.SWAP, status: notFailed, createdAt: { gte: since }, ...exclude });
      case PolicyAction.CRYPTO_WITHDRAW:
        return sumUsd({ userId, type: TxType.WITHDRAWAL, fromAsset: { not: 'ngn' }, status: notFailed, createdAt: { gte: since }, ...exclude });
      case PolicyAction.NGN_WITHDRAW:
        return sumNgn({ userId, type: TxType.WITHDRAWAL, fromAsset: 'ngn', status: notFailed, createdAt: { gte: since }, ...exclude });
      case PolicyAction.NGN_DEPOSIT:
        return sumNgn({ userId, type: TxType.DEPOSIT, toAsset: 'ngn', status: notFailed, createdAt: { gte: since }, ...exclude });
      case PolicyAction.GIFTCARD_SELL: {
        const r = await db.giftCardTrade.aggregate({
          where: { userId, status: { not: GiftCardTradeStatus.REJECTED }, createdAt: { gte: since } },
          _sum: { expectedNgn: true },
        });
        return dec(r._sum.expectedNgn ?? 0);
      }
      default:
        return ZERO;
    }
  }

  async evaluate(
    db: Db,
    userId: string,
    level: PolicyLevel,
    action: PolicyAction,
    amount: Decimal,
    unit: 'NGN' | 'USD',
    fx: Fx,
    opts: { now?: Date; excludeTransactionId?: string } = {},
  ): Promise<Verdict> {
    const now = opts.now ?? new Date();
    const rule = (await db.levelRule.findMany({ where: { level, action } }))[0] as LevelRule | undefined;
    const currency = (rule?.currency ?? 'NGN') as 'NGN' | 'USD';
    const minPerTx = rule?.minPerTx != null ? dec(rule.minPerTx) : null;
    const maxPerTx = rule?.maxPerTx != null ? dec(rule.maxPerTx) : null;
    const maxPerDay = rule?.maxPerDay != null ? dec(rule.maxPerDay) : null;
    const label = ACTIONS[action].label;

    const usedNative = await this.usedToday(db, userId, action, now, opts.excludeTransactionId);
    const used = this.convert(usedNative, ACTIONS[action].unit, currency, fx);
    const base = { currency, minPerTx, maxPerTx, maxPerDay, usedToday: used, remainingToday: maxPerDay ? maxPerDay.minus(used) : null };

    if (!rule || !rule.allowed) {
      return { ...base, allowed: false, reason: `Your account cannot ${label} yet.` };
    }
    const value = this.convert(amount, unit, currency, fx);
    if (minPerTx && value.lt(minPerTx)) {
      return { ...base, allowed: false, reason: `The smallest amount you can ${label} for is ${money(minPerTx, currency)}.` };
    }
    if (maxPerTx && value.gt(maxPerTx)) {
      return { ...base, allowed: false, reason: `The most you can ${label} for in one go is ${money(maxPerTx, currency)}.` };
    }
    if (maxPerDay && used.plus(value).gt(maxPerDay)) {
      const left = Decimal.max(maxPerDay.minus(used), 0);
      return {
        ...base,
        allowed: false,
        reason: left.lte(0)
          ? `You have used your ${money(maxPerDay, currency)} daily limit to ${label}. It resets at midnight.`
          : `That would take you past your ${money(maxPerDay, currency)} daily limit to ${label}. You have ${money(left, currency)} left today.`,
      };
    }
    if (TRADES.includes(action)) {
      const platform = await db.platformLimit.findUnique({ where: { id: 'default' } });
      if (platform?.tradingMaxPerDay != null) {
        const pc = platform.currency as 'NGN' | 'USD';
        const everyone = dec(
          (
            await db.transaction.aggregate({
              where: { type: { in: [TxType.BUY, TxType.SELL, TxType.SWAP] }, status: { not: TxStatus.FAILED }, createdAt: { gte: startOfLagosDay(now) } },
              _sum: { usdValue: true },
            })
          )._sum.usdValue ?? 0,
        );
        const total = this.convert(everyone, 'USD', pc, fx).plus(this.convert(amount, unit, pc, fx));
        if (total.gt(dec(platform.tradingMaxPerDay))) {
          return { ...base, allowed: false, reason: 'Trading has reached its daily limit. Please try again tomorrow.' };
        }
      }
    }
    return { ...base, allowed: true };
  }

  async assertWithinLimits(...args: Parameters<LevelPolicyService['evaluate']>): Promise<void> {
    const v = await this.evaluate(...args);
    if (!v.allowed) throw new BadRequestException(v.reason);
  }

  /** Withdrawals wait after sign-up and after a password/email change (spec D5). */
  async assertCooledOff(
    user: { id: string; createdAt: Date; credentialsChangedAt: Date | null; kycTier: KycTier },
    action: PolicyAction,
    now = new Date(),
  ): Promise<void> {
    const open = await this.withdrawalsOpenAt(user, action, now);
    if (!open) return;
    const when = formatLagos(open.until).replace(/^(\d+) (\w+) \d{4} at (\d{2}:\d{2}) WAT$/, '$3 on $1 $2');
    throw new ForbiddenException({
      code: 'COOLING_OFF',
      action,
      until: open.until.toISOString(),
      message: `Withdrawals open at ${when}, ${open.why}.`,
    });
  }

  /** The cool-off still running for this action, or null. */
  async withdrawalsOpenAt(
    user: { createdAt: Date; credentialsChangedAt: Date | null; kycTier: KycTier },
    action: PolicyAction,
    now = new Date(),
  ): Promise<{ until: Date; why: string } | null> {
    if (!ACTIONS[action].coolsOff) return null;
    const c = await this.prisma.levelCooloff.findUnique({ where: { level: levelOf(user.kycTier) } });
    if (!c) return null;
    const waits: Array<{ until: Date; why: string }> = [
      { until: new Date(user.createdAt.getTime() + c.afterSignupHours * HOUR), why: `${c.afterSignupHours} hours after sign-up` },
    ];
    if (user.credentialsChangedAt) {
      waits.push({
        until: new Date(user.credentialsChangedAt.getTime() + c.afterCredentialChangeHours * HOUR),
        why: `${c.afterCredentialChangeHours} hours after your password or email changed`,
      });
    }
    return waits.filter((w) => w.until > now).sort((a, b) => b.until.getTime() - a.until.getTime())[0] ?? null;
  }
}
