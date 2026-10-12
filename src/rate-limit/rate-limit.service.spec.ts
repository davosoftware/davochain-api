import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { RateLimitService, RedisUnavailableError } from './rate-limit.service';

/** Real Redis: atomicity and TTL behavior cannot be proven against a fake (spec §6). */
const HOST = process.env.REDIS_HOST ?? 'localhost';
const PORT = Number(process.env.REDIS_PORT ?? 6379);
const PASSWORD = process.env.REDIS_PASSWORD || undefined;

function client(port = PORT): Redis {
  return new Redis({
    host: HOST,
    port,
    password: PASSWORD,
    lazyConnect: true,
    enableOfflineQueue: false,
    commandTimeout: 500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
}

describe('RateLimitService on real Redis', () => {
  const prefix = `rltest:${randomUUID()}:`;
  const opened: Redis[] = [];
  let a: RateLimitService;
  let b: RateLimitService;
  let admin: Redis;

  beforeAll(async () => {
    const ra = client();
    const rb = client();
    admin = client();
    opened.push(ra, rb, admin);
    await Promise.all(opened.map((r) => r.connect()));
    a = new RateLimitService(ra);
    b = new RateLimitService(rb);
  });

  afterAll(async () => {
    const keys = await admin.keys(`${prefix}*`);
    if (keys.length) await admin.del(...keys);
    // disconnect, not quit: the deliberately dead client has no connection to quit.
    for (const r of opened) r.disconnect();
  });

  it('allows up to the limit, then refuses, counting remaining down', async () => {
    const key = `${prefix}basic`;
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await a.consume(key, { count: 3, windowMs: 60_000 }));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
  });

  it('says how long to wait, in whole seconds within the window', async () => {
    const key = `${prefix}retry`;
    const r = await a.consume(key, { count: 1, windowMs: 90_000 });
    expect(r.retryAfterSec).toBeGreaterThanOrEqual(89);
    expect(r.retryAfterSec).toBeLessThanOrEqual(90);
  });

  it('starts a fresh window once the old one expires', async () => {
    const key = `${prefix}window`;
    const limit = { count: 1, windowMs: 300 };
    expect((await a.consume(key, limit)).allowed).toBe(true);
    expect((await a.consume(key, limit)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 400));
    expect((await a.consume(key, limit)).allowed).toBe(true);
  });

  it('repairs a counter that lost its expiry, so it can never block forever', async () => {
    const key = `${prefix}nottl`;
    await admin.set(key, '50');
    await a.consume(key, { count: 10, windowMs: 60_000 });
    expect(await admin.pttl(key)).toBeGreaterThan(0);
  });

  it('admits exactly the limit when two servers race on one key', async () => {
    const key = `${prefix}race`;
    const limit = { count: 10, windowMs: 60_000 };
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => (i % 2 ? a : b).consume(key, limit)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it('reports a Redis it cannot reach as unavailable', async () => {
    const dead = client(1);
    opened.push(dead);
    await expect(new RateLimitService(dead).consume(`${prefix}dead`, { count: 1, windowMs: 1000 })).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
  });

  it('treats a Redis too slow to answer as unavailable, within about half a second', async () => {
    const slow = client();
    opened.push(slow);
    await slow.connect();
    const svc = new RateLimitService(slow);
    await admin.call('CLIENT', 'PAUSE', '1500', 'ALL');
    const started = Date.now();
    await expect(svc.consume(`${prefix}slow`, { count: 1, windowMs: 1000 })).rejects.toBeInstanceOf(RedisUnavailableError);
    expect(Date.now() - started).toBeLessThan(1200);
    await new Promise((r) => setTimeout(r, 1600)); // let the pause end before the next test
  });
});
