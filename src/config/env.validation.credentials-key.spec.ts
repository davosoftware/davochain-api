import { envSchema } from './env.validation';

/**
 * L5 (PROJECT_REVIEW): CREDENTIALS_KEY encrypts partner API keys and gift-card
 * codes. It is hashed into an AES key, so a short or guessable passphrase is
 * a weak key, and nothing stopped one being used live. On staging and
 * production it is now required, at least 32 characters (e.g. 32 random
 * bytes in base64: openssl rand -base64 32).
 */
const BASE = {
  DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
  JWT_SECRET: 'j'.repeat(32),
  JWT_REFRESH_SECRET: 'r'.repeat(32),
  ADMIN_JWT_SECRET: 'a'.repeat(32),
};
const keyIssues = (env: Record<string, string>) => {
  const parsed = envSchema.safeParse({ ...BASE, ...env });
  return parsed.success ? [] : parsed.error.issues.filter((i) => i.path.join('.') === 'CREDENTIALS_KEY').map((i) => i.message);
};
const MESSAGE = 'CREDENTIALS_KEY must be at least 32 characters in staging and production (e.g. openssl rand -base64 32)';

describe('L5: a strong CREDENTIALS_KEY outside development', () => {
  it.each(['staging', 'production'])('%s refuses a missing key', (NODE_ENV) => {
    expect(keyIssues({ NODE_ENV })).toContain(MESSAGE);
  });

  it.each(['staging', 'production'])('%s refuses a short passphrase', (NODE_ENV) => {
    expect(keyIssues({ NODE_ENV, CREDENTIALS_KEY: 'password123' })).toContain(MESSAGE);
  });

  it('accepts 32 random bytes in base64', () => {
    expect(keyIssues({ NODE_ENV: 'staging', CREDENTIALS_KEY: 'q7ZJ0n3m8xF4WcKkYH2e9pR5tV1aB6dE0gLsNuOiQwA=' })).toEqual([]);
  });

  it('development keeps working with whatever is set (or nothing)', () => {
    expect(keyIssues({ NODE_ENV: 'development' })).toEqual([]);
    expect(keyIssues({ NODE_ENV: 'development', CREDENTIALS_KEY: 'dev' })).toEqual([]);
  });
});
