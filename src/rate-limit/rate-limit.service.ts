import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Limit } from './policies';

/** The limiter's own Redis connection (rate-limit.module.ts). */
export const RATE_LIMIT_REDIS = Symbol('RATE_LIMIT_REDIS');

/** Redis did not answer: down, unreachable, or slower than the command timeout. */
export class RedisUnavailableError extends Error {
  override readonly name = 'RedisUnavailableError';
}

export interface ConsumeResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * One hit on a fixed-window counter, atomically (spec §2.2). The window starts
 * at the first hit. A key that somehow lost its expiry is given one again, so a
 * counter can never block forever.
 */
const HIT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { n, ttl }
`;

type HitRedis = Redis & { rlHit(key: string, windowMs: number): Promise<[number, number]> };

/**
 * Counts requests in Redis, shared by every API server. Knows nothing about
 * HTTP: the guard decides the keys and what a refusal looks like.
 */
@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly redis: HitRedis;

  constructor(@Inject(RATE_LIMIT_REDIS) redis: Redis) {
    // defineCommand sends EVALSHA and falls back to EVAL after a Redis restart.
    redis.defineCommand('rlHit', { numberOfKeys: 1, lua: HIT });
    this.redis = redis as HitRedis;
  }

  async consume(key: string, limit: Limit): Promise<ConsumeResult> {
    let reply: [number, number];
    try {
      reply = await this.redis.rlHit(key, limit.windowMs);
    } catch (err) {
      throw new RedisUnavailableError((err as Error).message);
    }
    const count = Number(reply[0]);
    const ttlMs = Number(reply[1]);
    return {
      allowed: count <= limit.count,
      remaining: Math.max(0, limit.count - count),
      retryAfterSec: Math.max(1, Math.ceil(ttlMs / 1000)),
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
