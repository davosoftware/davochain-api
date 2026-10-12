/**
 * Every request limit in the API, in one place (spec §3).
 *
 * Defaults live here. An operator overrides one at deploy time with
 * RATE_LIMIT_<POLICY>_<DIMENSION>=<count>/<window>, for example
 * RATE_LIMIT_AUTH_LOGIN_ACCT=10/15m. Nothing is editable from the dashboard,
 * so a compromised admin account cannot loosen brute-force protection.
 */

export const POLICY_NAMES = [
  'auth.login',
  'auth.register',
  'auth.reset',
  'auth.resetConfirm',
  'auth.refresh',
  'auth.changePassword',
  'webhooks',
  'public',
  'default',
] as const;
export type PolicyName = (typeof POLICY_NAMES)[number];

/** What a limit counts by: the client IP, the account named in the body, or the signed-in user. */
export type Dimension = 'ip' | 'acct' | 'user';

export interface Limit {
  count: number;
  windowMs: number;
}

export interface Policy {
  name: PolicyName;
  limits: Partial<Record<Dimension, Limit>>;
  /** Refuse with 503 when Redis is unreachable, rather than let the route run unlimited. */
  failClosed: boolean;
}

const S = 1_000;
const M = 60 * S;
const H = 60 * M;
const lim = (count: number, windowMs: number): Limit => ({ count, windowMs });

export const DEFAULT_POLICIES: Readonly<Record<PolicyName, Policy>> = {
  'auth.login': { name: 'auth.login', limits: { ip: lim(20, 15 * M), acct: lim(10, 15 * M) }, failClosed: true },
  'auth.register': { name: 'auth.register', limits: { ip: lim(5, H) }, failClosed: true },
  'auth.reset': { name: 'auth.reset', limits: { ip: lim(10, H), acct: lim(3, H) }, failClosed: true },
  'auth.resetConfirm': { name: 'auth.resetConfirm', limits: { ip: lim(20, H) }, failClosed: true },
  'auth.refresh': { name: 'auth.refresh', limits: { ip: lim(60, M) }, failClosed: true },
  'auth.changePassword': { name: 'auth.changePassword', limits: { user: lim(5, H) }, failClosed: true },
  // Generous on purpose: a 429 spends a provider's retries, and Quidax stops retrying after 24 h.
  webhooks: { name: 'webhooks', limits: { ip: lim(3000, M) }, failClosed: false },
  public: { name: 'public', limits: { ip: lim(120, M) }, failClosed: false },
  default: { name: 'default', limits: { user: lim(300, M) }, failClosed: false },
};

const UNIT_MS = { s: S, m: M, h: H } as const;
const MAX_WINDOW_MS = 24 * H;

/** "10/15m" → 10 per 15 minutes. Null for anything else, including zero and windows over a day. */
export function parseLimit(text: string): Limit | null {
  const m = /^\s*(\d{1,7})\s*\/\s*(\d{1,5})\s*([smh])\s*$/.exec(text);
  if (!m) return null;
  const count = Number(m[1]);
  const windowMs = Number(m[2]) * UNIT_MS[m[3] as keyof typeof UNIT_MS];
  if (count < 1 || windowMs < S || windowMs > MAX_WINDOW_MS) return null;
  return { count, windowMs };
}

/** auth.resetConfirm + ip → RATE_LIMIT_AUTH_RESET_CONFIRM_IP */
export function envName(policy: PolicyName, dimension: Dimension): string {
  const p = policy.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/\./g, '_').toUpperCase();
  return `RATE_LIMIT_${p}_${dimension.toUpperCase()}`;
}

type RawEnv = Record<string, string | undefined>;

function overrideNames(): Set<string> {
  const names = new Set<string>();
  for (const policy of POLICY_NAMES) {
    for (const dimension of Object.keys(DEFAULT_POLICIES[policy].limits) as Dimension[]) {
      names.add(envName(policy, dimension));
    }
  }
  return names;
}

/** Why the RATE_LIMIT_* variables are unusable; empty when they are fine. The API refuses to boot on any. */
export function rateLimitEnvProblems(env: RawEnv): string[] {
  const known = overrideNames();
  const problems: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('RATE_LIMIT_') || value === undefined || value === '') continue;
    if (!known.has(name)) {
      problems.push(`${name} is not a rate limit this API has (known: ${[...known].join(', ')})`);
    } else if (!parseLimit(value)) {
      problems.push(`${name}="${value}" must look like 10/15m: a count, a slash, and a window of 1s to 24h`);
    }
  }
  return problems;
}

/** The policies in force: the defaults, with any valid override applied. */
export function resolvePolicies(env: RawEnv): Record<PolicyName, Policy> {
  const out = {} as Record<PolicyName, Policy>;
  for (const name of POLICY_NAMES) {
    const base = DEFAULT_POLICIES[name];
    const limits: Policy['limits'] = {};
    for (const [dimension, limit] of Object.entries(base.limits) as Array<[Dimension, Limit]>) {
      const raw = env[envName(name, dimension)];
      limits[dimension] = (raw ? parseLimit(raw) : null) ?? limit;
    }
    out[name] = { ...base, limits };
  }
  return out;
}
