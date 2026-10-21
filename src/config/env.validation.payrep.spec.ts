import { envSchema } from './env.validation';

const BASE = {
  DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
  JWT_SECRET: 'j'.repeat(32),
  JWT_REFRESH_SECRET: 'r'.repeat(32),
  ADMIN_JWT_SECRET: 'a'.repeat(32),
};

/** The Payrep variables that have a problem, by name. */
function errorsFor(over: Record<string, string>): string[] {
  const parsed = envSchema.safeParse({ ...BASE, ...over });
  if (parsed.success) return [];
  return [...new Set(parsed.error.issues.map((i) => String(i.path[0])).filter((p) => p.startsWith('PAYREP_')))];
}

describe('Payrep env (spec §8)', () => {
  it('the mock is refused outside development and test', () => expect(errorsFor({ NODE_ENV: 'production', PAYREP_USE_MOCK: 'true' })).toContain('PAYREP_USE_MOCK'));
  it('empty values count as unset (the .env placeholders)', () => {
    expect(errorsFor({ PAYREP_USE_MOCK: 'true', PAYREP_CLIENT_ID: '', PAYREP_CLIENT_SECRET: '', PAYREP_MAIN_ACCOUNT: '', PAYREP_WEBHOOK_SECRET: '', PAYREP_BASE_URL: '' })).toEqual([]);
    const parsed = envSchema.parse({ ...BASE, PAYREP_MAIN_ACCOUNT: '', PAYREP_BASE_URL: '' });
    expect(parsed.PAYREP_MAIN_ACCOUNT).toBeUndefined();
    expect(parsed.PAYREP_BASE_URL).toBe('https://shogun-dev.payrepmfb.com');
    expect(parsed.PAYREP_USE_MOCK).toBe(true);
  });
  it('with the mock off, the main account and webhook secret are required', () => {
    expect(errorsFor({ PAYREP_USE_MOCK: 'false', PAYREP_CLIENT_ID: 'pk_test_a', PAYREP_CLIENT_SECRET: 'sk_test_b' })).toEqual(expect.arrayContaining(['PAYREP_MAIN_ACCOUNT', 'PAYREP_WEBHOOK_SECRET']));
  });
  it('a main account must be 10 digits; a secret must be 64 hex', () => {
    expect(errorsFor({ PAYREP_MAIN_ACCOUNT: '12345' })).toContain('PAYREP_MAIN_ACCOUNT');
    expect(errorsFor({ PAYREP_WEBHOOK_SECRET: 'xyz' })).toContain('PAYREP_WEBHOOK_SECRET');
  });
  it('live keys are refused outside production', () => {
    expect(errorsFor({ PAYREP_USE_MOCK: 'false', PAYREP_CLIENT_ID: 'pk_live_a', PAYREP_CLIENT_SECRET: 'sk_live_b', PAYREP_MAIN_ACCOUNT: '1234567890', PAYREP_WEBHOOK_SECRET: 'a'.repeat(64) })).toContain('PAYREP_CLIENT_SECRET');
  });
  it('a full test setup passes', () => {
    expect(errorsFor({ PAYREP_USE_MOCK: 'false', PAYREP_CLIENT_ID: 'pk_test_a', PAYREP_CLIENT_SECRET: 'sk_test_b', PAYREP_MAIN_ACCOUNT: '1234567890', PAYREP_WEBHOOK_SECRET: 'a'.repeat(64) })).toEqual([]);
  });
  it('https is required in staging and production', () => expect(errorsFor({ NODE_ENV: 'staging', PAYREP_USE_MOCK: 'false', PAYREP_BASE_URL: 'http://x.example' })).toContain('PAYREP_BASE_URL'));
});
