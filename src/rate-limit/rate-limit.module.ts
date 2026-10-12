import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RATE_LIMIT_REDIS, RateLimitService } from './rate-limit.service';

const log = new Logger('RateLimit');

/**
 * The limiter gets its own connection, separate from BullMQ's, tuned to fail
 * fast: no offline queue and a 500 ms command timeout. A dead Redis must turn
 * into a quick 503 on auth routes, not a request that hangs (spec §2.1).
 */
function limiterRedis(config: ConfigService): Redis {
  const redis = new Redis({
    host: config.get<string>('REDIS_HOST'),
    port: config.get<number>('REDIS_PORT'),
    password: config.get<string>('REDIS_PASSWORD') || undefined,
    lazyConnect: true,
    enableOfflineQueue: false,
    commandTimeout: 500,
    maxRetriesPerRequest: 1,
  });
  let lastLog = 0;
  redis.on('error', (err: Error) => {
    if (Date.now() - lastLog > 60_000) {
      lastLog = Date.now();
      log.warn(`Rate-limit Redis connection: ${err.message}`);
    }
  });
  // Boot does not wait for Redis; ioredis keeps reconnecting in the background.
  void redis.connect().catch(() => undefined);
  return redis;
}

@Global()
@Module({
  providers: [
    { provide: RATE_LIMIT_REDIS, inject: [ConfigService], useFactory: limiterRedis },
    RateLimitService,
  ],
  exports: [RateLimitService],
})
export class RateLimitModule {}
