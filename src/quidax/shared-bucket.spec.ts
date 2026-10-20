import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { LaneBusyError, SharedTokenBucket } from './shared-bucket';
import { TokenBucket } from './rate-limiter';

/**
 * M9: the Quidax speed limit is ONE budget for every API server, kept in
 * Redis, and a call never waits longer than its lane allows. Real Redis: the
 * point is what two servers see at the same moment (like rate-limit.service.spec).
 */
const HOST = process.env.REDIS_HOST ?? 'localhost';
const PORT = Number(process.env.REDIS_PORT ?? 6379);
const PASSWORD = process.env.REDIS_PASSWORD || undefined;

function client(port = PORT): Redis {
  return new Redis({ host: HOST, port, password: PASSWORD, lazyConnect: true, enableOfflineQueue: false, commandTimeout: 500, maxRetriesPerRequest: 1, retryStrategy: () => null });
}

describe('SharedTokenBucket on real Redis', () => {
  const opened: Redis[] = [];
  let a: Redis;
  let b: Redis;

  beforeAll(async () => {
    a = client();
    b = client();
    opened.push(a, b);
    await Promise.all([a.connect(), b.connect()]);
  });

  afterAll(async () => {
    await Promise.all(opened.map((r) => r.quit().catch(() => undefined)));
  });

  const key = () => `quidax:rl:test:${randomUUID()}`;

  it('two servers share one budget: 5 a minute is 5 in total, not 5 each', async () => {
    const k = key();
    const server1 = new SharedTokenBucket(a, k, 5, 5 / 60_000, TokenBucket.perMinute(5, 'local1'));
    const server2 = new SharedTokenBucket(b, k, 5, 5 / 60_000, TokenBucket.perMinute(5, 'local2'));
    for (let i = 0; i < 3; i++) await server1.take(0);
    for (let i = 0; i < 2; i++) await server2.take(0);
    // The 6th call anywhere would have to wait ~12 s: over a 1 s allowance, so refused.
    await expect(server1.take(1_000)).rejects.toBeInstanceOf(LaneBusyError);
    await expect(server2.take(1_000)).rejects.toBeInstanceOf(LaneBusyError);
    await a.del(k);
  });

  it('a call that fits within its allowance waits for its turn instead of failing', async () => {
    const k = key();
    const lane = new SharedTokenBucket(a, k, 1, 10 / 1_000, TokenBucket.perSecond(10, 'local')); // 10 a second
    await lane.take(0);
    const started = Date.now();
    await lane.take(1_000);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(60);
    expect(waited).toBeLessThan(1_000);
    await a.del(k);
  });

  it('a refused call does not use up budget meant for the next one', async () => {
    const k = key();
    const lane = new SharedTokenBucket(a, k, 1, 1 / 60_000, TokenBucket.perMinute(1, 'local'));
    await lane.take(0);
    for (let i = 0; i < 5; i++) await expect(lane.take(10)).rejects.toBeInstanceOf(LaneBusyError);
    const stored = await a.hget(k, 'tokens');
    expect(Number(stored)).toBeGreaterThan(-0.01); // never pushed into debt by refusals
    await a.del(k);
  });

  it('the busy error says how long to wait', async () => {
    const k = key();
    const lane = new SharedTokenBucket(a, k, 1, 1 / 60_000, TokenBucket.perMinute(1, 'local'));
    await lane.take(0);
    const err = await lane.take(10).catch((e) => e);
    expect(err).toBeInstanceOf(LaneBusyError);
    expect(err.retryAfterMs).toBeGreaterThan(50_000);
    await a.del(k);
  });

  it('with Redis down, each server falls back to its own budget (today\'s behaviour) instead of stopping', async () => {
    const dead = client(1); // nothing listens on port 1
    opened.push(dead);
    const local = TokenBucket.perMinute(2, 'local');
    const lane = new SharedTokenBucket(dead, key(), 2, 2 / 60_000, local);
    await lane.take(0);
    await lane.take(0);
    expect(local.available).toBe(0);
    await expect(lane.take(1_000)).rejects.toBeInstanceOf(LaneBusyError);
  });

  it('with no Redis at all (tests, scripts) it is the local budget', async () => {
    const local = TokenBucket.perMinute(1, 'local');
    const lane = new SharedTokenBucket(null, key(), 1, 1 / 60_000, local);
    await lane.take(0);
    await expect(lane.take(100)).rejects.toBeInstanceOf(LaneBusyError);
  });
});

describe('TokenBucket: a bounded wait', () => {
  it('refuses at once when the wait would be longer than allowed, and queues nothing', async () => {
    const b = TokenBucket.perMinute(1, 't');
    await b.take(0);
    await expect(b.take(1_000)).rejects.toBeInstanceOf(LaneBusyError);
    expect(b.pending).toBe(0);
  });

  it('counts the calls already waiting in front', async () => {
    const b = new TokenBucket(1, 10 / 1_000, 't'); // holds 1, one more every 100 ms
    await b.take(0);
    const first = b.take(150); // ~100 ms: allowed
    await expect(b.take(150)).rejects.toBeInstanceOf(LaneBusyError); // ~200 ms behind it: refused
    await first;
  });

  it('with no limit given it still waits as before', async () => {
    const b = TokenBucket.perSecond(20, 't');
    await b.take();
    await expect(b.take()).resolves.toBeUndefined();
  });
});
