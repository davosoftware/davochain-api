import type { QuoteSide } from '@prisma/client';
import { Decimal } from '../common/money';

/** Significant digits kept for a swap rate: enough for any coin pair, no false precision. */
const SWAP_SIGNIFICANT_DIGITS = 10;

/**
 * The `rate` a quote shows.
 *
 * Buy and sell rates are naira per dollar, where 4 decimals is plenty. A swap
 * rate is one coin per another (USDT -> BTC is about 0.000014), so a fixed 4
 * decimals read "0.0000". Swaps keep 10 significant digits, rounded down.
 */
export function formatQuoteRate(side: QuoteSide | string, rate: Decimal): string {
  if (side !== 'SWAP') return rate.toFixed(4, Decimal.ROUND_DOWN);
  return rate.toSignificantDigits(SWAP_SIGNIFICANT_DIGITS, Decimal.ROUND_DOWN).toFixed();
}
