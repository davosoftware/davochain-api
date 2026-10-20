import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { LaneBusyError, TokenBucket } from './rate-limiter';

export { LaneBusyError };

/**
 * One token bucket in Redis, atomically, on Redis's own clock (so servers
 * whose clocks disagree still share one budget).
 *
 * A call that fits takes its token now and is told how long to wait for its
 * turn (the bucket may go briefly into debt, which IS the queue). A call that
 * would wait longer than it may is refused and takes nothing.
 *
 * Returns { 1, waitMs } when the turn is reserved, { -1, waitMs } when refused.
 */
const TAKE = `
local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local maxWait = tonumber(ARGV[3])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local d = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(d[1])
local ts = tonumber(d[2])
if tokens == nil or ts == nil then tokens = cap; ts = now end
tokens = math.min(cap, tokens + math.max(0, now - ts) * rate)
local after = tokens - 1
local wait = 0
if after < 0 then wait = math.ceil(-after / rate) end
local ttl = math.ceil(cap / rate) + 60000
if wait > maxWait then
  redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
  redis.call('PEXPIRE', KEYS[1], ttl)
  return { -1, wait }
end
redis.call('HSET', KEYS[1], 'tokens', tostring(after), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], ttl)
return { 1, wait }
`;

type TakeRedis = Redis & { quidaxLaneTake(key: string, cap: string, rate: string, maxWait: string): Promise<[number, number]> };

const log = new Logger('QuidaxBudget');
let lastWarn = 0;

/**
 * M9: a Quidax rate-limit lane shared by every API server through Redis.
 *
 * Quidax's limit is per API key, and every server uses the same key, so the
 * budget must be counted once, not once per server. When Redis cannot be
 * reached the lane falls back to this server's own bucket (the old
 * behaviour): slower to protect, but trading does not stop.
 */
export class SharedTokenBucket {
  private readonly redis: TakeRedis | null;

  constructor(
    redis: Redis | null,
    private readonly key: string,
    private readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly local: TokenBucket,
  ) {
    if (redis && !(redis as unknown as { quidaxLaneTake?: unknown }).quidaxLaneTake) {
      redis.defineCommand('quidaxLaneTake', { numberOfKeys: 1, lua: TAKE });
    }
    this.redis = redis as unknown as TakeRedis | null;
  }

  get name(): string {
    return this.local.name;
  }

  async take(maxWaitMs: number): Promise<void> {
    if (!this.redis) return this.local.take(maxWaitMs);
    let reply: [number, number];
    try {
      reply = await this.redis.quidaxLaneTake(this.key, String(this.capacity), String(this.refillPerMs), String(maxWaitMs));
    } catch (err) {
      if (Date.now() - lastWarn > 60_000) {
        lastWarn = Date.now();
        log.warn(`Shared Quidax budget unavailable (${(err as Error).message}); using this server's own count until Redis is back.`);
      }
      return this.local.take(maxWaitMs);
    }
    const [ok, waitMs] = [Number(reply[0]), Number(reply[1])];
    if (ok < 0) throw new LaneBusyError(this.local.name, waitMs);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
