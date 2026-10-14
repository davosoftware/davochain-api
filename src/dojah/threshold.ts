/**
 * The Dojah wallet thresholds (plan §R2), computed rather than guessed.
 *
 *   C    = lookup + 2 × aml                 worst case for one Basic verification (§R1.3)
 *   MIN  = roundUp100(C × max(peakHour, 20)) the hard stop
 *   WARN = MIN + roundUp100(C × peakDay × leadDays)
 *
 * Prices are not published by Dojah; they come from your contract.
 */
export interface ThresholdInput {
  lookupPrice: number;
  amlPrice: number;
  peakHour: number;
  peakDay: number;
  leadDays: number;
}

export interface ThresholdResult {
  perVerification: number;
  minBalance: number;
  lowBalanceWarn: number;
  workings: string[];
}

const MIN_HOURLY_BUFFER = 20;

function roundUp100(x: number): number {
  // Work in kobo so 1066.6 never becomes 1066.5999… before rounding.
  const kobo = Math.round(x * 100);
  return Math.ceil(kobo / 10_000) * 100;
}

function positive(name: keyof ThresholdInput, v: number): number {
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a number greater than 0`);
  return v;
}

export function dojahThresholds(input: ThresholdInput): ThresholdResult {
  const lookup = positive('lookupPrice', input.lookupPrice);
  const aml = positive('amlPrice', input.amlPrice);
  const peakHour = positive('peakHour', input.peakHour);
  const peakDay = positive('peakDay', input.peakDay);
  const leadDays = positive('leadDays', input.leadDays);

  const perVerification = Math.round((lookup + 2 * aml) * 100) / 100;
  const buffer = Math.max(peakHour, MIN_HOURLY_BUFFER);
  const minBalance = roundUp100(perVerification * buffer);
  const cover = roundUp100(perVerification * peakDay * leadDays);
  const lowBalanceWarn = minBalance + cover;

  return {
    perVerification,
    minBalance,
    lowBalanceWarn,
    workings: [
      `C = ${lookup} + 2 × ${aml} = ${perVerification}`,
      `MIN = roundUp100(${perVerification} × max(${peakHour}, ${MIN_HOURLY_BUFFER})) = roundUp100(${perVerification} × ${buffer}) = ${minBalance}`,
      `WARN = ${minBalance} + roundUp100(${perVerification} × ${peakDay} × ${leadDays}) = ${minBalance} + ${cover} = ${lowBalanceWarn}`,
    ],
  };
}
