import { BadRequestException } from '@nestjs/common';
import { PolicyAction, TxType } from '@prisma/client';

/**
 * What counts toward each action's daily limit: the one definition shared by
 * the limits check (LevelPolicyService.usedToday) and the daily limits monitor
 * (DailyUsageService), so what an admin sees is what the check enforced.
 *
 * Transactions count unless FAILED (pending, held and being-checked ones
 * included: the money is committed); gift-card sales unless REJECTED.
 */
export type ActionTotal =
  | { from: 'transactions'; type: TxType; sum: 'usdValue' | 'toAmount'; fromAsset?: 'ngn' | { not: 'ngn' }; toAsset?: 'ngn' }
  | { from: 'giftcards' }
  | { from: 'none' };

export const ACTION_TOTALS: Record<PolicyAction, ActionTotal> = {
  BUY: { from: 'transactions', type: TxType.BUY, sum: 'usdValue' },
  SELL: { from: 'transactions', type: TxType.SELL, sum: 'usdValue' },
  SWAP: { from: 'transactions', type: TxType.SWAP, sum: 'usdValue' },
  CRYPTO_DEPOSIT: { from: 'none' },
  CRYPTO_WITHDRAW: { from: 'transactions', type: TxType.WITHDRAWAL, sum: 'usdValue', fromAsset: { not: 'ngn' } },
  NGN_WITHDRAW: { from: 'transactions', type: TxType.WITHDRAWAL, sum: 'toAmount', fromAsset: 'ngn' },
  NGN_DEPOSIT: { from: 'transactions', type: TxType.DEPOSIT, sum: 'toAmount', toAsset: 'ngn' },
  GIFTCARD_SELL: { from: 'giftcards' },
};

/** The limit a transaction row counts toward, or null for none. */
export function actionFor(row: { type: TxType; fromAsset: string | null; toAsset: string | null }): PolicyAction | null {
  for (const [action, spec] of Object.entries(ACTION_TOTALS) as Array<[PolicyAction, ActionTotal]>) {
    if (spec.from !== 'transactions' || spec.type !== row.type) continue;
    if (spec.fromAsset === 'ngn' && row.fromAsset !== 'ngn') continue;
    // As the database filter `{ not: 'ngn' }`, which also leaves out an empty asset.
    if (spec.fromAsset && typeof spec.fromAsset === 'object' && (row.fromAsset === null || row.fromAsset === 'ngn')) continue;
    if (spec.toAsset === 'ngn' && row.toAsset !== 'ngn') continue;
    return action;
  }
  return null;
}

const HOUR = 3_600_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A day in Lagos (UTC+1 all year): midnight to midnight, as instants. No date = today. */
export function lagosDay(date?: string, now = new Date()): { date: string; start: Date; end: Date } {
  let y: number, m: number, d: number;
  if (date) {
    const match = DATE.exec(date);
    if (!match) throw new BadRequestException('Use a date like 2026-10-27.');
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
      throw new BadRequestException('That date does not exist.');
    }
  } else {
    const lagos = new Date(now.getTime() + HOUR);
    [y, m, d] = [lagos.getUTCFullYear(), lagos.getUTCMonth() + 1, lagos.getUTCDate()];
  }
  const start = new Date(Date.UTC(y, m - 1, d) - HOUR);
  const end = new Date(start.getTime() + 24 * HOUR);
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { date: iso, start, end };
}
