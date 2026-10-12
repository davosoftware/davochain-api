import {
  DEFAULT_POLICIES,
  POLICY_NAMES,
  envName,
  parseLimit,
  rateLimitEnvProblems,
  resolvePolicies,
} from './policies';

const M = 60_000;
const H = 60 * M;

describe('parseLimit', () => {
  it('reads a count and a window in seconds, minutes or hours', () => {
    expect(parseLimit('10/15m')).toEqual({ count: 10, windowMs: 15 * M });
    expect(parseLimit('600/1m')).toEqual({ count: 600, windowMs: M });
    expect(parseLimit('5/1h')).toEqual({ count: 5, windowMs: H });
    expect(parseLimit('1/30s')).toEqual({ count: 1, windowMs: 30_000 });
    expect(parseLimit(' 3 / 2m ')).toEqual({ count: 3, windowMs: 2 * M });
  });

  it('refuses anything else, including zero and windows over a day', () => {
    for (const bad of ['', '10', '10/15', '0/1m', '10/0m', '10/25h', '-1/1m', 'ten/1m', '10/1d', '1.5/1m']) {
      expect(parseLimit(bad)).toBeNull();
    }
  });
});

describe('envName', () => {
  it('turns a policy and dimension into its override variable', () => {
    expect(envName('auth.login', 'acct')).toBe('RATE_LIMIT_AUTH_LOGIN_ACCT');
    expect(envName('auth.resetConfirm', 'ip')).toBe('RATE_LIMIT_AUTH_RESET_CONFIRM_IP');
    expect(envName('auth.changePassword', 'user')).toBe('RATE_LIMIT_AUTH_CHANGE_PASSWORD_USER');
    expect(envName('default', 'user')).toBe('RATE_LIMIT_DEFAULT_USER');
  });
});

describe('resolvePolicies', () => {
  it('uses the spec defaults when nothing is overridden', () => {
    const p = resolvePolicies({});
    expect(p['auth.login'].limits).toEqual({ ip: { count: 20, windowMs: 15 * M }, acct: { count: 10, windowMs: 15 * M } });
    expect(p['auth.register'].limits).toEqual({ ip: { count: 5, windowMs: H } });
    expect(p['auth.reset'].limits).toEqual({ ip: { count: 10, windowMs: H }, acct: { count: 3, windowMs: H } });
    expect(p['auth.resetConfirm'].limits).toEqual({ ip: { count: 20, windowMs: H } });
    expect(p['auth.refresh'].limits).toEqual({ ip: { count: 60, windowMs: M } });
    expect(p['auth.changePassword'].limits).toEqual({ user: { count: 5, windowMs: H } });
    expect(p.webhooks.limits).toEqual({ ip: { count: 3000, windowMs: M } });
    expect(p.public.limits).toEqual({ ip: { count: 120, windowMs: M } });
    expect(p.default.limits).toEqual({ user: { count: 300, windowMs: M } });
  });

  it('applies a valid override to one dimension only, without touching the defaults', () => {
    const p = resolvePolicies({ RATE_LIMIT_AUTH_LOGIN_ACCT: '3/1m' });
    expect(p['auth.login'].limits.acct).toEqual({ count: 3, windowMs: M });
    expect(p['auth.login'].limits.ip).toEqual({ count: 20, windowMs: 15 * M });
    expect(DEFAULT_POLICIES['auth.login'].limits.acct).toEqual({ count: 10, windowMs: 15 * M });
  });

  it('fails closed on every auth policy and open on the rest', () => {
    const p = resolvePolicies({});
    for (const name of POLICY_NAMES) {
      expect(p[name].failClosed).toBe(name.startsWith('auth.'));
    }
  });
});

describe('rateLimitEnvProblems', () => {
  it('accepts valid overrides and ignores empty ones and unrelated variables', () => {
    expect(
      rateLimitEnvProblems({
        RATE_LIMIT_AUTH_LOGIN_ACCT: '10/15m',
        RATE_LIMIT_PUBLIC_IP: '',
        QUIDAX_RATE_LIMIT_PER_MINUTE: '240',
      }),
    ).toEqual([]);
  });

  it('names a malformed value and an override the policy does not have', () => {
    const problems = rateLimitEnvProblems({
      RATE_LIMIT_AUTH_LOGIN_ACCT: '10 per minute',
      RATE_LIMIT_AUTH_LOGIN_USER: '5/1m',
    });
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toMatch(/RATE_LIMIT_AUTH_LOGIN_ACCT="10 per minute" must look like 10\/15m/);
    expect(problems.join('\n')).toMatch(/RATE_LIMIT_AUTH_LOGIN_USER is not a rate limit this API has/);
  });
});
