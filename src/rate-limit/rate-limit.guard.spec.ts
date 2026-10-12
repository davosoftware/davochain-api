import { ExecutionContext, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AlertType } from '@prisma/client';
import { RateLimit } from './rate-limit.decorator';
import { RateLimitGuard, accountKey, ipKey } from './rate-limit.guard';
import { RedisUnavailableError } from './rate-limit.service';
import type { Limit } from './policies';

/** The real counter's semantics, in memory: per-key counts, refused past the limit. */
class MemoryLimiter {
  counts = new Map<string, number>();
  keys: string[] = [];
  down = false;
  async consume(key: string, limit: Limit) {
    if (this.down) throw new RedisUnavailableError('connection refused');
    this.keys.push(key);
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return { allowed: n <= limit.count, remaining: Math.max(0, limit.count - n), retryAfterSec: Math.ceil(limit.windowMs / 1000) };
  }
}

class Routes {
  @RateLimit('auth.login') login() {}
  @RateLimit('auth.changePassword') changePassword() {}
  plain() {}
}

@RateLimit('public')
class PublicRoutes {
  page() {}
}

function setup() {
  const limiter = new MemoryLimiter();
  const alerts = { raise: jest.fn(async () => true) };
  const guard = new RateLimitGuard(new Reflector(), limiter as never, alerts as never);
  const headers: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => (headers[k] = v) };
  const call = (handler: () => void, cls: object, req: Record<string, unknown>) =>
    guard.canActivate({
      getType: () => 'http',
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext);
  return { limiter, alerts, headers, call };
}

const login = (ip: string, email?: unknown) => ({ ip, body: email === undefined ? {} : { email } });

async function refusal(p: Promise<boolean>): Promise<HttpException> {
  try {
    await p;
  } catch (err) {
    return err as HttpException;
  }
  throw new Error('expected a refusal');
}

describe('RateLimitGuard', () => {
  it('limits one account across many IPs, with a Retry-After header, and leaves other accounts alone', async () => {
    const { call, headers } = setup();
    for (let i = 0; i < 10; i++) {
      await expect(call(Routes.prototype.login, Routes, login(`10.0.0.${i}`, 'ada@x.com'))).resolves.toBe(true);
    }
    const err = await refusal(call(Routes.prototype.login, Routes, login('10.0.0.99', 'ada@x.com')));
    expect(err.getStatus()).toBe(429);
    expect(err.getResponse()).toEqual({ statusCode: 429, message: 'Too many attempts. Try again in 900 seconds.' });
    expect(headers['Retry-After']).toBe('900');
    await expect(call(Routes.prototype.login, Routes, login('10.0.0.99', 'bola@x.com'))).resolves.toBe(true);
  });

  it('answers an IP trip and an account trip with the same message', async () => {
    const byIp = setup();
    for (let i = 0; i < 20; i++) await byIp.call(Routes.prototype.login, Routes, login('1.1.1.1', `u${i}@x.com`));
    const ipErr = await refusal(byIp.call(Routes.prototype.login, Routes, login('1.1.1.1', 'new@x.com')));
    const byAcct = setup();
    for (let i = 0; i < 10; i++) await byAcct.call(Routes.prototype.login, Routes, login(`2.2.2.${i}`, 'ada@x.com'));
    const acctErr = await refusal(byAcct.call(Routes.prototype.login, Routes, login('2.2.2.99', 'ada@x.com')));
    expect(ipErr.getResponse()).toEqual(acctErr.getResponse());
  });

  it('keys an account by a hash of the normalized email, never the email itself', async () => {
    const { call, limiter } = setup();
    await call(Routes.prototype.login, Routes, login('1.1.1.1', '  Ada@X.com '));
    await call(Routes.prototype.login, Routes, login('1.1.1.2', 'ada@x.com'));
    expect(limiter.keys.join(' ')).not.toMatch(/ada/i);
    expect(limiter.counts.get(`rl:auth.login:acct:${accountKey('ada@x.com')}`)).toBe(2);
    expect(accountKey('ada@x.com')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('skips only the account key when the email is missing or not a non-empty string', async () => {
    for (const email of [undefined, '', '   ', 42, ['a@x.com'], { $ne: null }]) {
      const { call, limiter } = setup();
      await expect(call(Routes.prototype.login, Routes, login('3.3.3.3', email))).resolves.toBe(true);
      expect(limiter.keys).toEqual(['rl:auth.login:ip:3.3.3.3']);
    }
    const { call, limiter } = setup();
    await expect(call(Routes.prototype.login, Routes, { ip: '3.3.3.4' })).resolves.toBe(true);
    expect(limiter.keys).toEqual(['rl:auth.login:ip:3.3.3.4']);
  });

  it('keys a user limit by the signed-in user, and by IP where there is none (admin routes)', async () => {
    const { call, limiter } = setup();
    await call(Routes.prototype.changePassword, Routes, { ip: '4.4.4.4', user: { sub: 'user-1' } });
    await call(Routes.prototype.changePassword, Routes, { ip: '4.4.4.4' });
    expect(limiter.keys).toEqual(['rl:auth.changePassword:user:user-1', 'rl:auth.changePassword:ip:4.4.4.4']);
  });

  it('applies the default policy to an undecorated route and a class-level policy to its methods', async () => {
    const { call, limiter } = setup();
    await call(Routes.prototype.plain, Routes, { ip: '5.5.5.5', user: { sub: 'user-2' } });
    await call(PublicRoutes.prototype.page, PublicRoutes, { ip: '5.5.5.5' });
    expect(limiter.keys).toEqual(['rl:default:user:user-2', 'rl:public:ip:5.5.5.5']);
  });

  it('consumes every key even when one is already over, and waits for the longest', async () => {
    // A 1-minute account window against the 15-minute IP window, so "the longest" is visible.
    process.env.RATE_LIMIT_AUTH_LOGIN_ACCT = '10/1m';
    try {
      const { call, limiter, headers } = setup();
      for (let i = 0; i < 10; i++) await call(Routes.prototype.login, Routes, login('6.6.6.6', 'same@x.com'));
      await refusal(call(Routes.prototype.login, Routes, login('6.6.6.6', 'same@x.com')));
      expect(headers['Retry-After']).toBe('60'); // only the account key is over
      for (let i = 12; i <= 20; i++) await call(Routes.prototype.login, Routes, login('6.6.6.6', 'same@x.com')).catch(() => false);
      const before = limiter.keys.length;
      await refusal(call(Routes.prototype.login, Routes, login('6.6.6.6', 'same@x.com')));
      expect(limiter.keys.length - before).toBe(2); // both keys counted on the 21st
      expect(headers['Retry-After']).toBe('900'); // both over: the longer wait wins
    } finally {
      delete process.env.RATE_LIMIT_AUTH_LOGIN_ACCT;
    }
  });

  it('refuses auth routes with 503 when Redis is down, and lets other routes through with one alert', async () => {
    const { call, limiter, alerts } = setup();
    limiter.down = true;
    const err = await refusal(call(Routes.prototype.login, Routes, login('7.7.7.7', 'ada@x.com')));
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getResponse()).toMatchObject({ message: 'Temporarily unavailable. Try again shortly.' });
    for (let i = 0; i < 50; i++) {
      await expect(call(PublicRoutes.prototype.page, PublicRoutes, { ip: '7.7.7.7' })).resolves.toBe(true);
    }
    expect(alerts.raise).toHaveBeenCalledTimes(1);
    expect(alerts.raise.mock.calls[0]).toEqual(
      expect.arrayContaining([AlertType.RATE_LIMIT_DEGRADED, 'rate-limit-degraded']),
    );
  });

  it('counts an IPv6 client by its /64, so one device cannot rotate through its own addresses', async () => {
    const { call, limiter } = setup();
    for (let i = 1; i <= 20; i++) {
      await call(Routes.prototype.login, Routes, login(`2001:db8:abcd:12::${i.toString(16)}`, `u${i}@x.com`));
    }
    const err = await refusal(call(Routes.prototype.login, Routes, login('2001:db8:abcd:12:ffff::99', 'new@x.com')));
    expect(err.getStatus()).toBe(429);
    expect(limiter.counts.get('rl:auth.login:ip:2001:db8:abcd:12::/64')).toBe(21);
    await expect(call(Routes.prototype.login, Routes, login('2001:db8:abcd:13::1', 'other@x.com'))).resolves.toBe(true);
  });

  it('keys IPv4, IPv4-mapped IPv6 and odd IPv6 spellings consistently', () => {
    expect(ipKey('203.0.113.9')).toBe('203.0.113.9');
    expect(ipKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(ipKey('::FFFF:203.0.113.9')).toBe('203.0.113.9');
    expect(ipKey('2001:0db8:0000:0012:0000:0000:0000:0001')).toBe('2001:db8:0:12::/64');
    expect(ipKey('2001:db8::12:1')).toBe('2001:db8:0:0::/64');
    expect(ipKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(ipKey('::1')).toBe('0:0:0:0::/64');
    expect(ipKey('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64');
    expect(ipKey('not-an-ip')).toBe('not-an-ip');
  });

  it('leaves non-HTTP contexts alone', async () => {
    const { limiter } = setup();
    const guard = new RateLimitGuard(new Reflector(), limiter as never, { raise: jest.fn() } as never);
    await expect(guard.canActivate({ getType: () => 'rpc' } as unknown as ExecutionContext)).resolves.toBe(true);
    expect(limiter.keys).toEqual([]);
  });
});
