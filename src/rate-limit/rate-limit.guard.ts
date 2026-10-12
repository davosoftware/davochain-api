import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AlertType } from '@prisma/client';
import { createHash } from 'node:crypto';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { RATE_LIMIT_KEY } from './rate-limit.decorator';
import { RateLimitService, RedisUnavailableError } from './rate-limit.service';
import { Dimension, Limit, PolicyName, resolvePolicies } from './policies';

interface LimitedRequest {
  ip?: string;
  body?: unknown;
  user?: { sub?: string };
}

/** What Redis holds instead of an email: the SHA-256 of the trimmed, lowercased address. */
export function accountKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

const DEGRADED_LOG_MS = 60_000;

/**
 * Every request passes here (spec §2). It runs after JwtAuthGuard, so a
 * signed-in user is known by the time a `user` limit is counted.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly log = new Logger(RateLimitGuard.name);
  // .env is loaded into process.env by ConfigModule before any guard is built.
  private readonly policies = resolvePolicies(process.env);
  private lastDegraded = 0;

  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
    private readonly alerts: OpsAlertsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const name =
      this.reflector.getAllAndOverride<PolicyName>(RATE_LIMIT_KEY, [ctx.getHandler(), ctx.getClass()]) ?? 'default';
    const policy = this.policies[name];
    const req = ctx.switchToHttp().getRequest<LimitedRequest>();

    const keys = this.keysFor(name, policy.limits, req);
    let results;
    try {
      // Every key is counted, even after one is over, so a refusal never says which one tripped.
      results = await Promise.all(keys.map(({ key, limit }) => this.limiter.consume(key, limit)));
    } catch (err) {
      if (!(err instanceof RedisUnavailableError)) throw err;
      if (policy.failClosed) throw new ServiceUnavailableException('Temporarily unavailable. Try again shortly.');
      this.degraded(err);
      return true;
    }

    const refused = results.filter((r) => !r.allowed);
    if (refused.length === 0) return true;
    const wait = Math.max(...refused.map((r) => r.retryAfterSec));
    ctx.switchToHttp().getResponse<{ setHeader(k: string, v: string): void }>().setHeader('Retry-After', String(wait));
    throw new HttpException(
      { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: `Too many attempts. Try again in ${wait} seconds.` },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private keysFor(
    name: PolicyName,
    limits: Partial<Record<Dimension, Limit>>,
    req: LimitedRequest,
  ): Array<{ key: string; limit: Limit }> {
    const ip = req.ip ?? 'unknown';
    const keys: Array<{ key: string; limit: Limit }> = [];
    for (const [dimension, limit] of Object.entries(limits) as Array<[Dimension, Limit]>) {
      if (dimension === 'ip') {
        keys.push({ key: `rl:${name}:ip:${ip}`, limit });
      } else if (dimension === 'acct') {
        const email = (req.body as { email?: unknown } | undefined)?.email;
        if (typeof email === 'string' && email.trim() !== '') {
          keys.push({ key: `rl:${name}:acct:${accountKey(email)}`, limit });
        }
      } else {
        const sub = req.user?.sub;
        keys.push({ key: sub ? `rl:${name}:user:${sub}` : `rl:${name}:ip:${ip}`, limit });
      }
    }
    return keys;
  }

  /** Redis is gone and this route fails open: say so, once a minute per process at most. */
  private degraded(err: Error): void {
    if (Date.now() - this.lastDegraded < DEGRADED_LOG_MS) return;
    this.lastDegraded = Date.now();
    this.log.warn(`Rate limiting is degraded (Redis unreachable): ${err.message}`);
    void this.alerts.raise(AlertType.RATE_LIMIT_DEGRADED, 'rate-limit-degraded', 'Rate limiting is degraded: Redis is unreachable', [
      `Error: ${err.message}`,
      'Sign-in, registration and password routes are refusing with 503 until Redis is back.',
      'Every other route is running without request limits.',
    ]);
  }
}
