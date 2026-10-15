import { BadRequestException } from '@nestjs/common';
import { Prisma, TxStatus, TxType } from '@prisma/client';
import { Decimal, dec } from '../common/money';

const HOUR = 3_600_000;

/** Midnight in Lagos (UTC+1 all year, no daylight saving), as an instant. */
export function startOfLagosDay(now = new Date()): Date {
  const lagos = new Date(now.getTime() + HOUR);
  return new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate()) - HOUR);
}

export interface DailyCaps {
  userUsd: Decimal;
  platformUsd: Decimal;
}

/** MAX_USER_DAILY_USD and MAX_PLATFORM_DAILY_USD from the environment. */
export function dailyCapsFrom(config: { get<T>(key: string): T | undefined }): DailyCaps {
  return {
    userUsd: dec(config.get<number>('MAX_USER_DAILY_USD') ?? 5000),
    platformUsd: dec(config.get<number>('MAX_PLATFORM_DAILY_USD') ?? 50000),
  };
}

/**
 * H10 (PROJECT_REVIEW): the daily trading limits, per user and for the whole
 * platform, counted in USD over today's buys, sells and swaps (a refunded,
 * FAILED trade does not count).
 *
 * Call it inside the serializable write that locks the trade's funds: two
 * trades at the same moment then cannot both pass on the same remaining
 * allowance. Quotes call it too, only so the person hears early.
 */
export async function assertDailyCaps(
  t: Pick<Prisma.TransactionClient, 'transaction'>,
  userId: string,
  usdValue: Decimal,
  caps: DailyCaps,
  now = new Date(),
): Promise<void> {
  const counted: Prisma.TransactionWhereInput = {
    type: { in: [TxType.BUY, TxType.SELL, TxType.SWAP] },
    status: { not: TxStatus.FAILED },
    createdAt: { gte: startOfLagosDay(now) },
  };
  const [mine, everyone] = await Promise.all([
    t.transaction.aggregate({ where: { userId, ...counted }, _sum: { usdValue: true } }),
    t.transaction.aggregate({ where: counted, _sum: { usdValue: true } }),
  ]);
  const usedByUser = dec(mine._sum.usdValue ?? 0);
  if (usedByUser.plus(usdValue).gt(caps.userUsd)) {
    const left = Decimal.max(caps.userUsd.minus(usedByUser), 0);
    throw new BadRequestException(
      `This trade would take you over your daily limit of $${caps.userUsd.toFixed(2)}. You can trade $${left.toFixed(2)} more today.`,
    );
  }
  if (dec(everyone._sum.usdValue ?? 0).plus(usdValue).gt(caps.platformUsd)) {
    throw new BadRequestException('Trading has reached its daily limit. Please try again tomorrow.');
  }
}
