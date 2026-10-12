import { isIP } from 'node:net';

const NAMED_RANGES = ['loopback', 'linklocal', 'uniquelocal'];

/**
 * One entry Express's 'trust proxy' understands: a named range, an IP, or an
 * IP with a prefix length. Host names are refused: Express would not resolve
 * them, and the setting would silently trust nothing.
 */
export function isProxyAddress(entry: string): boolean {
  if (NAMED_RANGES.includes(entry)) return true;
  const [ip, prefix, extra] = entry.split('/');
  const version = isIP(ip ?? '');
  if (!version || extra !== undefined) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (version === 4 ? 32 : 128);
}

/**
 * What main.ts hands to app.set('trust proxy') (spec §2.5).
 *
 * Preferred: the proxy's own addresses. X-Forwarded-For is then believed only
 * on a connection that comes from Nginx itself, so a client that reaches the
 * API port directly cannot claim another IP. Fallback: a hop count, which
 * trusts whoever connects, and is only safe when nothing but the proxy can
 * reach the API. Neither: X-Forwarded-For is ignored.
 */
export function trustProxySetting(env: { TRUST_PROXY_ADDRESSES?: string[]; TRUST_PROXY_HOPS?: number }): string[] | number {
  if (env.TRUST_PROXY_ADDRESSES && env.TRUST_PROXY_ADDRESSES.length > 0) return env.TRUST_PROXY_ADDRESSES;
  return env.TRUST_PROXY_HOPS ?? 0;
}
