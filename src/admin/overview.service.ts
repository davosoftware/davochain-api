import { Injectable } from '@nestjs/common';
import { Prisma, TxStatus, TxType, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Decimal, ZERO, dec } from '../common/money';

export interface DateRange {
  from?: Date;
  to?: Date;
}

/**
 * The numbers on the dashboard.
 *
 * Aggregated here rather than in the browser because these are sums over every
 * transaction ever made — the kind of thing a database does in one pass and a
 * client does by downloading the table.
 *
 * Only COMPLETED transactions count. A pending buy is not money that moved, and
 * a failed one is money that came back; totalling either would make the
 * dashboard disagree with the ledger.
 *
 * A date range narrows the FLOWS — what happened between two dates. It cannot
 * narrow a BALANCE: what users hold is true right now and has no date range, so
 * those figures ignore the filter, and the screen says so rather than letting
 * somebody read them as belonging to the period.
 */
@Injectable()
export class OverviewService {
  constructor(private readonly prisma: PrismaService) {}

  /** The range clause, shared by every flow query so they always agree. */
  private window(range: DateRange): Record<string, unknown> {
    if (!range.from && !range.to) return {};
    return {
      createdAt: {
        ...(range.from ? { gte: range.from } : {}),
        ...(range.to ? { lte: range.to } : {}),
      },
    };
  }

  private async sum(
    where: Record<string, unknown>,
    field: 'fromAmount' | 'toAmount' | 'usdValue' | 'feeUsd' | 'feeAmount',
    range: DateRange,
  ): Promise<Decimal> {
    const result = await this.prisma.transaction.aggregate({
      where: { status: TxStatus.COMPLETED, ...this.window(range), ...where },
      _sum: { [field]: true } as never,
    });
    const value = (result._sum as Record<string, unknown>)[field];
    return value ? dec(value as string) : ZERO;
  }

  private async count(where: Record<string, unknown>, range: DateRange): Promise<number> {
    return this.prisma.transaction.count({
      where: { status: TxStatus.COMPLETED, ...this.window(range), ...where },
    });
  }

  /**
   * The rate fee, in naira.
   *
   * A product of two stored columns — the trade's dollar size and the gate that
   * was live when it settled — which no aggregate helper can express, hence raw
   * SQL. Both are historical, so this is what was actually earned, not what the
   * same trades would earn under today's ladder.
   */
  private async rateFeeNgn(range: DateRange): Promise<Decimal> {
    const clauses: Prisma.Sql[] = [
      Prisma.sql`"status" = 'COMPLETED'`,
      Prisma.sql`"type" IN ('BUY', 'SELL')`,
      Prisma.sql`"usdValue" IS NOT NULL`,
      Prisma.sql`"gateApplied" IS NOT NULL`,
    ];
    if (range.from) clauses.push(Prisma.sql`"createdAt" >= ${range.from}`);
    if (range.to) clauses.push(Prisma.sql`"createdAt" <= ${range.to}`);

    const rows = await this.prisma.$queryRaw<{ earned: Prisma.Decimal | null }[]>`
      SELECT COALESCE(SUM("usdValue" * "gateApplied"), 0) AS earned
      FROM "transactions"
      WHERE ${Prisma.join(clauses, ' AND ')}
    `;
    return dec(rows[0]?.earned ?? 0);
  }

  async snapshot(range: DateRange = {}) {
    const w = this.window(range);

    const [
      users,
      active,
      suspended,
      kycApproved,
      kycPending,

      ngnDeposits,
      ngnWithdrawals,
      ngnSpentBuying,
      ngnFromSelling,
      ngnHeld,

      buys,
      sells,
      swaps,
      cryptoDeposits,
      cryptoWithdrawals,
      boughtUsd,
      soldUsd,
      swappedUsd,
      depositedUsd,
      withdrawnUsd,

      rateFeeNgn,
      swapFeeUsd,
      ngnWithdrawalFeeNgn,
      withdrawalFeeUsd,
      giftCardProfitNgn,

      txTotal,
      txPending,
      txFailed,
    ] = await Promise.all([
      this.prisma.user.count({ where: w }),
      this.prisma.user.count({ where: { status: UserStatus.ACTIVE, ...w } }),
      this.prisma.user.count({ where: { status: UserStatus.SUSPENDED, ...w } }),
      this.prisma.user.count({ where: { kycStatus: 'APPROVED', ...w } }),
      this.prisma.user.count({ where: { kycStatus: 'PENDING', ...w } }),

      this.sum({ type: TxType.DEPOSIT, toAsset: 'ngn' }, 'toAmount', range),
      this.sum({ type: TxType.WITHDRAWAL, fromAsset: 'ngn' }, 'fromAmount', range),
      this.sum({ type: TxType.BUY, fromAsset: 'ngn' }, 'fromAmount', range),
      this.sum({ type: TxType.SELL, toAsset: 'ngn' }, 'toAmount', range),
      // A balance, not a flow: what users hold is true now, so no range applies.
      // Available and locked are kept apart because locked naira is already
      // committed to a trade in flight — counting it as spendable overstates it.
      this.prisma.balance
        .aggregate({ where: { assetCode: 'ngn' }, _sum: { available: true, locked: true } })
        .then((r) => ({
          available: dec(r._sum.available ?? 0),
          locked: dec(r._sum.locked ?? 0),
        })),

      this.count({ type: TxType.BUY }, range),
      this.count({ type: TxType.SELL }, range),
      this.count({ type: TxType.SWAP }, range),
      this.count({ type: TxType.DEPOSIT, NOT: { toAsset: 'ngn' } }, range),
      this.count({ type: TxType.WITHDRAWAL, NOT: { fromAsset: 'ngn' } }, range),

      // Dollars, from the figure each trade was quoted at. Coin amounts cannot
      // be added across assets, and repricing history would answer what it
      // would be worth today rather than what actually moved.
      this.sum({ type: TxType.BUY }, 'usdValue', range),
      this.sum({ type: TxType.SELL }, 'usdValue', range),
      this.sum({ type: TxType.SWAP }, 'usdValue', range),
      // Transfers in and out, priced when they landed. Excludes the naira leg,
      // which the NGN Wallet already reports in naira.
      this.sum({ type: TxType.DEPOSIT, NOT: { toAsset: 'ngn' } }, 'usdValue', range),
      this.sum({ type: TxType.WITHDRAWAL, NOT: { fromAsset: 'ngn' } }, 'usdValue', range),

      this.rateFeeNgn(range),
      this.sum({ type: TxType.SWAP }, 'feeUsd', range),
      // Charged in naira and stored in naira, so it is summed from feeAmount.
      // Scoped to the naira leg, which is the only place that unit is safe.
      this.sum({ type: TxType.WITHDRAWAL, fromAsset: 'ngn' }, 'feeAmount', range),
      // The platform's share of a CRYPTO withdrawal only. The chain's fee lives
      // in networkFee and is money that left, not money that was earned; the
      // naira leg is counted above, in naira.
      this.sum({ type: TxType.WITHDRAWAL, NOT: { fromAsset: 'ngn' } }, 'feeUsd', range),
      // The margin on a traded gift card: what the desk cleared it at, less
      // what the user was quoted. Stored in naira on the transaction, so it
      // sums the same way the naira withdrawal fee does.
      this.sum({ type: TxType.GIFT_CARD }, 'feeAmount', range),

      this.prisma.transaction.count({ where: w }),
      this.prisma.transaction.count({
        where: { status: { in: [TxStatus.PENDING, TxStatus.PROCESSING, TxStatus.ON_HOLD] }, ...w },
      }),
      this.prisma.transaction.count({
        where: { status: { in: [TxStatus.FAILED, TxStatus.RECONCILING] }, ...w },
      }),
    ]);

    return {
      range: {
        from: range.from?.toISOString() ?? null,
        to: range.to?.toISOString() ?? null,
      },
      users: { total: users, active, suspended, kycApproved, kycPending },
      ngn: {
        deposits: ngnDeposits.toFixed(2),
        withdrawals: ngnWithdrawals.toFixed(2),
        spentBuying: ngnSpentBuying.toFixed(2),
        fromSelling: ngnFromSelling.toFixed(2),
        available: ngnHeld.available.toFixed(2),
        locked: ngnHeld.locked.toFixed(2),
      },
      /** Dollars that actually moved. */
      crypto: {
        boughtUsd: boughtUsd.toFixed(2),
        soldUsd: soldUsd.toFixed(2),
        swappedUsd: swappedUsd.toFixed(2),
        depositedUsd: depositedUsd.toFixed(2),
        withdrawnUsd: withdrawnUsd.toFixed(2),
      },
      /**
       * What the platform kept. Two currencies, deliberately never added
       * together: the rate fee is naira folded into a naira trade, and the swap
       * fee is a flat dollar charge on a trade with no naira leg at all.
       */
      earnings: {
        rateFeeNgn: rateFeeNgn.toFixed(2),
        swapFeeUsd: swapFeeUsd.toFixed(2),
        withdrawalFeeUsd: withdrawalFeeUsd.toFixed(2),
        ngnWithdrawalFeeNgn: ngnWithdrawalFeeNgn.toFixed(2),
        giftCardProfitNgn: giftCardProfitNgn.toFixed(2),
      },
      /** Counts — how many of each thing happened, and how they ended. */
      transactions: {
        total: txTotal,
        buys,
        sells,
        swaps,
        deposits: cryptoDeposits,
        withdrawals: cryptoWithdrawals,
        pending: txPending,
        failed: txFailed,
      },
    };
  }
}

export type OverviewSnapshot = Awaited<ReturnType<OverviewService['snapshot']>>;
