/**
 * Prints DOJAH_MIN_BALANCE and DOJAH_LOW_BALANCE_WARN for production (plan §R2).
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"CommonJS"}' scripts/dojah-threshold.ts \
 *        --lookup <₦ per lookup> --aml <₦ per AML screen> --peak-hour <n> --peak-day <n> [--lead-days 3]
 *
 * Prices come from your Dojah contract or invoice. If Dojah bills in dollars,
 * convert at the rate you pay plus 10% before passing them in.
 */
import { dojahThresholds } from '../src/dojah/threshold';

function arg(name: string, fallback?: string): number {
  const i = process.argv.indexOf(`--${name}`);
  const raw = i >= 0 ? process.argv[i + 1] : fallback;
  if (raw === undefined) {
    console.error(`Missing --${name}`);
    process.exit(2);
  }
  return Number(raw);
}

try {
  const r = dojahThresholds({
    lookupPrice: arg('lookup'),
    amlPrice: arg('aml'),
    peakHour: arg('peak-hour'),
    peakDay: arg('peak-day'),
    leadDays: arg('lead-days', '3'),
  });
  console.log(r.workings.join('\n'));
  console.log('');
  console.log(`DOJAH_MIN_BALANCE=${r.minBalance}`);
  console.log(`DOJAH_LOW_BALANCE_WARN=${r.lowBalanceWarn}`);
  console.log('');
  console.log(`Fund the wallet to at least ₦${r.lowBalanceWarn.toLocaleString('en-NG')}.`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
