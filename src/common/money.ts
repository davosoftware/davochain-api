import { Decimal } from 'decimal.js';

/**
 * Money rules, in one place.
 *
 *  1. Never Float. Decimal end to end. Quidax gives you strings — keep them
 *     strings until they hit a Decimal, and never .toNumber() a balance.
 *  2. Round the user's entitlement DOWN, always. Round up and you pay the
 *     difference on every trade, fifteen coins wide, forever.
 *  3. Price the trade from the ROUNDED amount, never the other way round —
 *     that is what stops rounding losses existing at all.
 */

// 38 significant digits, matching Decimal(38,18) in Postgres.
Decimal.set({ precision: 40, toExpNeg: -30, toExpPos: 40 });

export { Decimal };

export type Numeric = Decimal | string | number;

export function dec(v: Numeric): Decimal {
  return v instanceof Decimal ? v : new Decimal(v as string);
}

/** Serialise for the API boundary. Never hand a Decimal to JSON.stringify raw. */
export function str(v: Numeric, dp?: number): string {
  const d = dec(v);
  return dp === undefined ? d.toFixed() : d.toFixed(dp, Decimal.ROUND_DOWN);
}

/**
 * Round an amount down onto a coin's transfer step.
 *
 * Precision is the note size: if the only notes you have are ₦100 you cannot
 * pay ₦970. Digits past the step are LOST, not padded — which is why this
 * always rounds down and why the caller must re-price from the result.
 */
export function floorToStep(amount: Numeric, step: Numeric | null | undefined): Decimal {
  const a = dec(amount);
  if (!step) return a;
  const s = dec(step);
  if (s.lte(0)) return a;
  return a.div(s).floor().mul(s);
}

/** Round down to a fixed number of decimal places. */
export function floorTo(amount: Numeric, decimals: number): Decimal {
  return dec(amount).toDecimalPlaces(decimals, Decimal.ROUND_DOWN);
}

/**
 * The minimum a coin can be traded at, from three constraints:
 *
 *   • your commercial floor        — $10, or $5 on stablecoins
 *   • 100 × the step in USD        — keeps rounding under 1%
 *   • 1.2 × Quidax's transfer min  — their floor, plus headroom
 *
 * The third is denominated in COIN, so its dollar value moves with the price.
 * Compute this per quote. Never cache it, never hardcode it.
 */
export function minTradeUsd(params: {
  floorUsd: Numeric;
  stepUsd?: Numeric | null;
  transferMinUsd?: Numeric | null;
}): Decimal {
  const candidates = [dec(params.floorUsd)];
  if (params.stepUsd) candidates.push(dec(params.stepUsd).mul(100));
  if (params.transferMinUsd) candidates.push(dec(params.transferMinUsd).mul(1.2));
  return candidates.reduce((max, c) => (c.gt(max) ? c : max));
}

/** Basis points between two rates, for the margin-deviation trip. */
export function deviationBps(actual: Numeric, expected: Numeric): Decimal {
  const e = dec(expected);
  if (e.isZero()) return new Decimal(0);
  return dec(actual).minus(e).div(e).mul(10_000).abs();
}

export const ZERO = new Decimal(0);
