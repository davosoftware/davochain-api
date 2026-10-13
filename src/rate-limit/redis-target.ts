const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** True only for a Redis on this machine. */
export function isLocalRedisHost(host: string): boolean {
  return LOCAL.has(host.trim().toLowerCase());
}

/**
 * The slow-Redis test runs CLIENT PAUSE ALL, which freezes every client of
 * that Redis (REDIS_TEST_PAUSE_EXPLAINED.md). Local only, unless someone sets
 * ALLOW_REDIS_PAUSE_TEST=1 deliberately.
 */
export function pauseTestAllowed(host: string, env: Record<string, string | undefined>): boolean {
  return isLocalRedisHost(host) || env.ALLOW_REDIS_PAUSE_TEST === '1';
}
