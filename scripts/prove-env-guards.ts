/**
 * Proves the configuration guards — the ones that stop a bad deploy coming up
 * looking healthy.
 *
 * Run: npx ts-node --compiler-options {"module":"CommonJS"} scripts/prove-env-guards.ts
 */
import { validateEnv } from '../src/config/env.validation';

const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(48),
  JWT_REFRESH_SECRET: 'y'.repeat(48),
  ADMIN_JWT_SECRET: 'z'.repeat(48),
};

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Runs the validator and reports the message, or null when it accepted. */
function refuses(env: Record<string, unknown>): string | null {
  try {
    validateEnv({ ...BASE, ...env });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

console.log('\n── production must not run against the mock ──');
const mockInProd = refuses({ NODE_ENV: 'production', QUIDAX_USE_MOCK: 'true' });
check('refuses to boot', mockInProd !== null);
check(
  'and says why',
  Boolean(mockInProd?.includes('QUIDAX_USE_MOCK must be false in production')),
  mockInProd?.split('\n')[1]?.trim(),
);

console.log('\n── live Quidax needs its key and its webhook secret ──');
const noKey = refuses({ QUIDAX_USE_MOCK: 'false' });
check('refuses without QUIDAX_SECRET_KEY', Boolean(noKey?.includes('QUIDAX_SECRET_KEY')));
check('refuses without QUIDAX_WEBHOOK_SECRET', Boolean(noKey?.includes('QUIDAX_WEBHOOK_SECRET')));

const live = refuses({
  NODE_ENV: 'production',
  QUIDAX_USE_MOCK: 'false',
  QUIDAX_SECRET_KEY: 'sk_live_example',
  QUIDAX_WEBHOOK_SECRET: 'whsec_example',
});
check('accepts a complete production config', live === null, live ?? '');

console.log('\n── CORS_ORIGINS parses as a list ──');
const parsed = validateEnv({
  ...BASE,
  CORS_ORIGINS: 'https://admin.davochain.com, https://davochain.com ,',
});
check(
  'splits, trims, and drops the empty tail',
  JSON.stringify(parsed.CORS_ORIGINS) ===
    JSON.stringify(['https://admin.davochain.com', 'https://davochain.com']),
  JSON.stringify(parsed.CORS_ORIGINS),
);
check('empty means an empty list, not [""]', validateEnv(BASE).CORS_ORIGINS.length === 0);

console.log('\n── these are warnings, not refusals ──');
check(
  'boots without CREDENTIALS_KEY',
  refuses({ NODE_ENV: 'production', QUIDAX_USE_MOCK: 'false', QUIDAX_SECRET_KEY: 'k', QUIDAX_WEBHOOK_SECRET: 'w' }) === null,
);
check(
  'boots without CORS_ORIGINS',
  refuses({
    NODE_ENV: 'production',
    QUIDAX_USE_MOCK: 'false',
    QUIDAX_SECRET_KEY: 'k',
    QUIDAX_WEBHOOK_SECRET: 'w',
    CORS_ORIGINS: '',
  }) === null,
);

console.log(`\n${failures === 0 ? 'ALL GUARDS HOLD' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
