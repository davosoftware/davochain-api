import { Injectable } from '@nestjs/common';
import { GiftCardTradeStatus, KycStatus, LevelRule, PolicyAction, PolicyLevel, Prisma, TxStatus, TxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Decimal, ZERO, dec } from '../common/money';
import { ACTIONS, levelOf } from './levels';
import { ACTION_TOTALS, actionFor, lagosDay } from './daily-usage';
import { LevelPolicyService, convertAmount } from './level-policy.service';

export interface ActionUsage {
  action: PolicyAction;
  label: string;
  allowed: boolean;
  currency: 'NGN' | 'USD';
  maxPerTx: string | null;
  maxPerDay: string | null;
  used: string;
  remaining: string | null;
  /** Used as a percentage of the daily limit; null when there's no daily limit. */
  percent: number | null;
}

export interface CustomerUsage {
  userId: string;
  email: string;
  name: string;
  level: PolicyLevel;
  /** The highest percentage of any daily limit used: how close they are to a limit. */
  highestPercent: number | null;
  actions: ActionUsage[];
}

const TYPES = [...new Set(Object.values(ACTION_TOTALS).flatMap((t) => (t.from === 'transactions' ? [t.type] : [])))] as TxType[];
const two = (d: Decimal) => d.toFixed(2);

/**
 * The daily limits monitor (27 Oct 2026). For a Lagos day, each customer's use
 * of each verification-level limit, worked out from the transaction records
 * with the same definition the limits check enforces (ACTION_TOTALS). Nothing
 * is stored. Totals are converted into each limit's currency at today's ₦/$
 * rate (for a past day this can differ slightly from the rate at the time).
 */
@Injectable()
export class DailyUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: LevelPolicyService,
  ) {}

  async forDay(opts: { date?: string; userId?: string; nearPercent?: number; action?: PolicyAction; search?: string }) {
    const day = lagosDay(opts.date);
    const who: Prisma.TransactionWhereInput = opts.userId ? { userId: opts.userId } : {};

    const [txGroups, giftGroups, rules, fx] = await Promise.all([
      this.prisma.transaction.groupBy({
        by: ['userId', 'type', 'fromAsset', 'toAsset'],
        where: { ...who, type: { in: TYPES }, status: { not: TxStatus.FAILED }, createdAt: { gte: day.start, lt: day.end } },
        _sum: { usdValue: true, toAmount: true },
      }),
      this.prisma.giftCardTrade.groupBy({
        by: ['userId'],
        where: { ...(opts.userId ? { userId: opts.userId } : {}), status: { not: GiftCardTradeStatus.REJECTED }, createdAt: { gte: day.start, lt: day.end } },
        _sum: { expectedNgn: true },
      }),
      this.prisma.levelRule.findMany(),
      this.policy.fx(),
    ]);

    // Each customer's total per action, in the action's own unit.
    const totals = new Map<string, Map<PolicyAction, Decimal>>();
    const add = (userId: string, action: PolicyAction, amount: Decimal) => {
      const mine = totals.get(userId) ?? new Map<PolicyAction, Decimal>();
      mine.set(action, (mine.get(action) ?? ZERO).plus(amount));
      totals.set(userId, mine);
    };
    for (const g of txGroups) {
      const action = actionFor(g);
      if (!action) continue;
      const spec = ACTION_TOTALS[action];
      if (spec.from !== 'transactions') continue;
      add(g.userId, action, dec(g._sum[spec.sum] ?? 0));
    }
    for (const g of giftGroups) add(g.userId, PolicyAction.GIFTCARD_SELL, dec(g._sum.expectedNgn ?? 0));
    if (opts.userId && !totals.has(opts.userId)) totals.set(opts.userId, new Map());

    const search = opts.search?.trim();
    const users = await this.prisma.user.findMany({
      where: {
        id: { in: [...totals.keys()] },
        ...(search
          ? { OR: [{ email: { contains: search, mode: 'insensitive' } }, { firstName: { contains: search, mode: 'insensitive' } }, { lastName: { contains: search, mode: 'insensitive' } }] }
          : {}),
      },
      select: { id: true, email: true, firstName: true, lastName: true, kycTier: true, kycStatus: true, amlStatus: true },
    });

    const ruleOf = (level: PolicyLevel, action: PolicyAction) => rules.find((r: LevelRule) => r.level === level && r.action === action);
    const customers: CustomerUsage[] = users.map((u) => {
      // As the limits check: a level above None counts only once approved and screened.
      const level = u.kycStatus === KycStatus.APPROVED && u.amlStatus === 'CLEAR' ? levelOf(u.kycTier) : PolicyLevel.NONE;
      const mine = totals.get(u.id) ?? new Map<PolicyAction, Decimal>();
      const actions = (Object.keys(ACTIONS) as PolicyAction[])
        .filter((a) => ACTION_TOTALS[a].from !== 'none')
        .map((action): ActionUsage => {
          const rule = ruleOf(level, action);
          const currency = (rule?.currency ?? 'NGN') as 'NGN' | 'USD';
          const used = convertAmount(mine.get(action) ?? ZERO, ACTIONS[action].unit, currency, fx);
          const maxPerDay = rule?.maxPerDay != null ? dec(rule.maxPerDay) : null;
          return {
            action,
            label: ACTIONS[action].label,
            allowed: Boolean(rule?.allowed),
            currency,
            maxPerTx: rule?.maxPerTx != null ? two(dec(rule.maxPerTx)) : null,
            maxPerDay: maxPerDay ? two(maxPerDay) : null,
            used: two(used),
            remaining: maxPerDay ? two(Decimal.max(maxPerDay.minus(used), 0)) : null,
            percent: maxPerDay && maxPerDay.gt(0) ? Number(used.div(maxPerDay).mul(100).toFixed(1)) : null,
          };
        });
      const counted = opts.action ? actions.filter((a) => a.action === opts.action) : actions;
      const percents = counted.map((a) => a.percent).filter((p): p is number => p !== null);
      return {
        userId: u.id,
        email: u.email,
        name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim(),
        level,
        highestPercent: percents.length ? Math.max(...percents) : null,
        actions,
      };
    });

    const kept = customers
      .filter((c) => !opts.action || (totals.get(c.userId)?.get(opts.action) ?? ZERO).gt(0) || opts.userId)
      .filter((c) => opts.nearPercent == null || (c.highestPercent ?? 0) >= opts.nearPercent)
      .sort((a, b) => (b.highestPercent ?? -1) - (a.highestPercent ?? -1) || a.email.localeCompare(b.email));

    return { date: day.date, ngnPerUsd: fx.ngnPerUsd.toFixed(2), customers: kept };
  }
}
