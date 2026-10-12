import { envSchema, validateEnv } from './env.validation';

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

describe('rate limiting environment rules', () => {
  it('requires TRUST_PROXY_HOPS in production only', () => {
    expect(issues({ NODE_ENV: 'production' }, 'TRUST_PROXY_HOPS')[0]).toMatch(/required in production/);
    expect(issues({ NODE_ENV: 'production', TRUST_PROXY_HOPS: '1' }, 'TRUST_PROXY_HOPS')).toEqual([]);
    expect(issues({ NODE_ENV: 'development' }, 'TRUST_PROXY_HOPS')).toEqual([]);
  });

  it('takes TRUST_PROXY_HOPS as a whole number from 0 to 5', () => {
    for (const bad of ['-1', '1.5', 'x', '6']) {
      expect(issues({ NODE_ENV: 'development', TRUST_PROXY_HOPS: bad }, 'TRUST_PROXY_HOPS').length).toBeGreaterThan(0);
    }
    const ok = envSchema.parse({ ...BASE, TRUST_PROXY_HOPS: '2' });
    expect(ok.TRUST_PROXY_HOPS).toBe(2);
    expect(envSchema.parse(BASE).TRUST_PROXY_HOPS).toBeUndefined();
  });

  it('defaults the hash cap to 4 at once and 32 waiting, and refuses a zero concurrency', () => {
    const env = envSchema.parse(BASE);
    expect(env.PASSWORD_HASH_CONCURRENCY).toBe(4);
    expect(env.PASSWORD_HASH_QUEUE).toBe(32);
    expect(issues({ PASSWORD_HASH_CONCURRENCY: '0' }, 'PASSWORD_HASH_CONCURRENCY')[0]).toMatch(/at least 1/);
    expect(issues({ PASSWORD_HASH_QUEUE: '-1' }, 'PASSWORD_HASH_QUEUE')[0]).toMatch(/0 or more/);
  });

  it('refuses to boot on a malformed or unknown RATE_LIMIT_ override, and accepts a valid one', () => {
    expect(() => validateEnv({ ...BASE, RATE_LIMIT_AUTH_LOGIN_ACCT: 'lots' })).toThrow(
      /RATE_LIMIT_AUTH_LOGIN_ACCT="lots" must look like 10\/15m/,
    );
    expect(() => validateEnv({ ...BASE, RATE_LIMIT_NOPE_IP: '1/1m' })).toThrow(/RATE_LIMIT_NOPE_IP is not a rate limit/);
    expect(() => validateEnv({ ...BASE, RATE_LIMIT_AUTH_LOGIN_ACCT: '5/1m' })).not.toThrow();
  });
});
