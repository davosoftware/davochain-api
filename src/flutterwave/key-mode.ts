/** Flutterwave test secret keys start with this; live keys do not. */
export const FLW_TEST_KEY_PREFIX = 'FLWSECK_TEST-';

/**
 * Why a key must not be used in this environment, or null when it may.
 *
 * Live keys only in production, test keys everywhere else: a developer's laptop
 * can never move real money, and production can never quietly run on the
 * sandbox. The message never contains the key.
 */
export function keyModeProblem(key: string, nodeEnv: string): string | null {
  const isTest = key.startsWith(FLW_TEST_KEY_PREFIX);
  if (nodeEnv === 'production' && isTest) {
    return 'A Flutterwave TEST key (FLWSECK_TEST-…) cannot be used in production';
  }
  if (nodeEnv !== 'production' && !isTest) {
    return `A Flutterwave LIVE key can only be used in production (NODE_ENV is ${nodeEnv})`;
  }
  return null;
}
