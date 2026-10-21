import { envSchema } from './env.validation';

const BASE = {
  DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
  JWT_SECRET: 'j'.repeat(32),
  JWT_REFRESH_SECRET: 'r'.repeat(32),
  ADMIN_JWT_SECRET: 'a'.repeat(32),
};
/** Production needs these for other reasons; set them so only Dojah rules show. */
const PROD = {
  NODE_ENV: 'production',
  PAYREP_USE_MOCK: 'false',
  PAYREP_MAIN_ACCOUNT: '7801234567',
  PAYREP_WEBHOOK_SECRET: 'a'.repeat(64),
  KYC_HASH_KEY: 'k'.repeat(32),
  TRUST_PROXY_ADDRESSES: '127.0.0.1',
  DOJAH_USE_MOCK: 'false',
  DOJAH_BASE_URL: 'https://api.dojah.io',
  DOJAH_MIN_BALANCE: '8000',
};

function issues(raw: Record<string, string>, path: string): string[] {
  const parsed = envSchema.safeParse({ ...BASE, ...raw });
  if (parsed.success) return [];
  return parsed.error.issues.filter((i) => i.path.join('.') === path).map((i) => i.message);
}

describe('Dojah environment rules', () => {
  it('keeps Basic switched off unless turned on explicitly', () => {
    const parsed = envSchema.parse({ ...BASE });
    expect(parsed.KYC_BASIC_ENABLED).toBe(false);
    expect(parsed.DOJAH_USE_MOCK).toBe(true);
    expect(parsed.KYC_BASIC_DAILY_ATTEMPTS).toBe(3);
    expect(parsed.KYC_BASIC_TOTAL_ATTEMPTS).toBe(10);
  });

  it('refuses the mock outside development and test', () => {
    expect(issues({ ...PROD, DOJAH_USE_MOCK: 'true' }, 'DOJAH_USE_MOCK')[0]).toMatch(/only allowed in development and test/);
    expect(issues({ NODE_ENV: 'staging', DOJAH_USE_MOCK: 'true' }, 'DOJAH_USE_MOCK')[0]).toMatch(/only allowed/);
    expect(issues({ NODE_ENV: 'development', DOJAH_USE_MOCK: 'true' }, 'DOJAH_USE_MOCK')).toEqual([]);
  });

  it('allows the live URL only in production, and the sandbox everywhere else', () => {
    expect(issues({ ...PROD, DOJAH_BASE_URL: 'https://sandbox.dojah.io' }, 'DOJAH_BASE_URL')[0]).toMatch(/production must use https:\/\/api\.dojah\.io/);
    expect(issues({ NODE_ENV: 'development', DOJAH_BASE_URL: 'https://api.dojah.io' }, 'DOJAH_BASE_URL')[0]).toMatch(/live Dojah URL is only allowed in production/);
    expect(issues({ NODE_ENV: 'staging', DOJAH_USE_MOCK: 'false', DOJAH_BASE_URL: 'http://sandbox.dojah.io' }, 'DOJAH_BASE_URL')[0]).toMatch(/https/);
    expect(issues({ ...PROD }, 'DOJAH_BASE_URL')).toEqual([]);
  });

  it('requires a positive DOJAH_MIN_BALANCE in production, with no default', () => {
    const { DOJAH_MIN_BALANCE: _omit, ...noMin } = PROD;
    void _omit;
    expect(issues(noMin, 'DOJAH_MIN_BALANCE')[0]).toMatch(/required in production/);
    expect(issues({ ...PROD, DOJAH_MIN_BALANCE: '0' }, 'DOJAH_MIN_BALANCE')[0]).toMatch(/greater than 0/);
    expect(issues({ ...PROD, DOJAH_MIN_BALANCE: '5,000' }, 'DOJAH_MIN_BALANCE')[0]).toMatch(/decimal/);
    expect(issues({ NODE_ENV: 'development' }, 'DOJAH_MIN_BALANCE')).toEqual([]);
  });

  it('requires the warning level to sit above the hard stop', () => {
    expect(issues({ ...PROD, DOJAH_LOW_BALANCE_WARN: '8000' }, 'DOJAH_LOW_BALANCE_WARN')[0]).toMatch(/greater than DOJAH_MIN_BALANCE/);
    expect(issues({ ...PROD, DOJAH_LOW_BALANCE_WARN: '152000' }, 'DOJAH_LOW_BALANCE_WARN')).toEqual([]);
  });
});
