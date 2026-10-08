import { envSchema } from './env.validation';

/** The minimum the rest of the schema needs, so these tests see only Flutterwave rules. */
const BASE = {
  DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
  JWT_SECRET: 'j'.repeat(32),
  JWT_REFRESH_SECRET: 'r'.repeat(32),
  ADMIN_JWT_SECRET: 'a'.repeat(32),
};

function issues(raw: Record<string, string>, path: string): string[] {
  const parsed = envSchema.safeParse({ ...BASE, ...raw });
  if (parsed.success) return [];
  return parsed.error.issues.filter((i) => i.path.join('.') === path).map((i) => i.message);
}

describe('Flutterwave environment rules', () => {
  it('allows the mock in development and test only', () => {
    expect(issues({ NODE_ENV: 'development', FLW_USE_MOCK: 'true' }, 'FLW_USE_MOCK')).toEqual([]);
    expect(issues({ NODE_ENV: 'test', FLW_USE_MOCK: 'true' }, 'FLW_USE_MOCK')).toEqual([]);
    expect(issues({ NODE_ENV: 'staging', FLW_USE_MOCK: 'true' }, 'FLW_USE_MOCK')[0]).toMatch(/only allowed in development and test/);
    expect(issues({ NODE_ENV: 'production', FLW_USE_MOCK: 'true' }, 'FLW_USE_MOCK')[0]).toMatch(/only allowed/);
  });

  it('defaults the mock on, which staging must override', () => {
    expect(issues({ NODE_ENV: 'staging' }, 'FLW_USE_MOCK')[0]).toMatch(/only allowed/);
  });

  it('refuses a key in the wrong mode when the mock is off', () => {
    expect(issues({ NODE_ENV: 'development', FLW_USE_MOCK: 'false', FLW_SECRET_KEY: 'FLWSECK-live-X' }, 'FLW_SECRET_KEY')[0]).toMatch(/LIVE key/);
    expect(issues({ NODE_ENV: 'production', FLW_USE_MOCK: 'false', FLW_SECRET_KEY: 'FLWSECK_TEST-x-X' }, 'FLW_SECRET_KEY')[0]).toMatch(/TEST key/);
    expect(issues({ NODE_ENV: 'development', FLW_USE_MOCK: 'false', FLW_SECRET_KEY: 'FLWSECK_TEST-x-X' }, 'FLW_SECRET_KEY')).toEqual([]);
  });

  it('requires a long KYC_HASH_KEY in staging and production', () => {
    expect(issues({ NODE_ENV: 'production', FLW_USE_MOCK: 'false' }, 'KYC_HASH_KEY')[0]).toMatch(/required in staging and production/);
    expect(issues({ NODE_ENV: 'development', KYC_HASH_KEY: 'short' }, 'KYC_HASH_KEY')[0]).toMatch(/at least 32/);
    expect(issues({ NODE_ENV: 'production', FLW_USE_MOCK: 'false', KYC_HASH_KEY: 'k'.repeat(32) }, 'KYC_HASH_KEY')).toEqual([]);
  });

  it('requires https for Flutterwave in staging and production', () => {
    const prod = { NODE_ENV: 'production', FLW_USE_MOCK: 'false', KYC_HASH_KEY: 'k'.repeat(32) };
    expect(issues({ ...prod, FLW_BASE_URL: 'http://api.flutterwave.com/v3' }, 'FLW_BASE_URL')[0]).toMatch(/https/);
    expect(issues({ ...prod, FLW_BASE_URL: 'https://api.flutterwave.com/v3' }, 'FLW_BASE_URL')).toEqual([]);
    expect(issues({ NODE_ENV: 'development', FLW_BASE_URL: 'http://localhost:9999' }, 'FLW_BASE_URL')).toEqual([]);
  });

  it('defaults naira deposits off', () => {
    const parsed = envSchema.safeParse({ ...BASE, NODE_ENV: 'development' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.NGN_DEPOSITS_ENABLED).toBe(false);
  });
});
