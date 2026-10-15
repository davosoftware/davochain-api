import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Observable, catchError, from, mergeMap, of, switchMap, throwError } from 'rxjs';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { JobLeaseService } from './job-lease.service';

/** M4: kept long enough for any client retry; then removed. */
const RETENTION_MS = 7 * 86_400_000;
/** M4: the final answer for a request that crashed part-way. */
const CRASHED = {
  statusCode: 500,
  message: 'Something went wrong while processing this request. Check your history before trying again with a new Idempotency-Key.',
};
import type { JwtPayload } from '../auth/auth.service';

/**
 * Replaying a mutating request returns the original result — the action does
 * not happen twice.
 *
 * The stored request hash matters: the same key with a DIFFERENT body is a
 * client bug, and returning the old response would silently swallow it. That
 * case is rejected rather than replayed.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly log = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly leases?: JobLeaseService,
  ) {}

  /** M4: delete keys older than the retention window. */
  async cleanup(): Promise<number> {
    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - RETENTION_MS) } },
    });
    if (count > 0) this.log.log(`Removed ${count} idempotency key(s) older than 7 days`);
    return count;
  }

  @Cron('30 3 * * *', { name: 'idempotency-cleanup' })
  async cleanupCron(): Promise<void> {
    try {
      if (this.leases) await this.leases.run('idempotency-cleanup', 10 * 60_000, () => this.cleanup());
      else await this.cleanup();
    } catch (err) {
      this.log.error(`Idempotency cleanup failed: ${(err as Error).message}`);
    }
  }

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<{
      method: string;
      headers: Record<string, string | undefined>;
      body: unknown;
      user?: JwtPayload;
    }>();

    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next.handle();

    const clientKey = req.headers['idempotency-key'];
    if (!clientKey) {
      throw new BadRequestException('Idempotency-Key header is required for this request');
    }
    if (clientKey.length > 200) throw new BadRequestException('Idempotency-Key is too long');

    const userId = req.user?.sub ?? 'anonymous';
    const requestHash = createHash('sha256')
      .update(JSON.stringify(req.body ?? {}))
      .digest('hex');
    // M4: a key belongs to one user. Stored scoped (and hashed, so its length
    // is fixed): another user's identical key is a different request, and
    // cannot be used to learn which keys someone else sent.
    const key = createHash('sha256').update(`${userId}\u0000${clientKey}`).digest('hex');

    return from(this.prisma.idempotencyKey.findUnique({ where: { key } })).pipe(
      switchMap((existing) => {
        if (existing) {
          if (existing.userId !== userId || existing.requestHash !== requestHash) {
            throw new ConflictException(
              'This Idempotency-Key was already used with a different request',
            );
          }
          if (existing.statusCode === 202) {
            throw new ConflictException('This request is still processing');
          }

          const response = ctx.switchToHttp().getResponse<{ status(code: number): unknown }>();
          response.status(existing.statusCode);
          if (existing.statusCode >= 400) {
            throw new HttpException(existing.response as string | Record<string, unknown>, existing.statusCode);
          }
          return of(existing.response);
        }

        return from(
          this.prisma.idempotencyKey
            .create({
              data: {
                key,
                userId,
                requestHash,
                statusCode: 202,
                response: { state: 'PROCESSING' },
              },
            })
            .then(() => true)
            .catch((err: { code?: string }) => {
              if (err.code === 'P2002') return false;
              throw err;
            }),
        ).pipe(
          switchMap((reserved) => {
            if (!reserved) {
              return from(this.prisma.idempotencyKey.findUnique({ where: { key } })).pipe(
                switchMap((racing) => {
                  if (!racing) throw new ConflictException('Could not reserve this request');
                  if (racing.userId !== userId || racing.requestHash !== requestHash) {
                    throw new ConflictException(
                      'This Idempotency-Key was already used with a different request',
                    );
                  }
                  if (racing.statusCode === 202) {
                    throw new ConflictException('This request is still processing');
                  }
                  const response = ctx
                    .switchToHttp()
                    .getResponse<{ status(code: number): unknown }>();
                  response.status(racing.statusCode);
                  if (racing.statusCode >= 400) {
                    throw new HttpException(
                      racing.response as string | Record<string, unknown>,
                      racing.statusCode,
                    );
                  }
                  return of(racing.response);
                }),
              );
            }

            const persist = async (statusCode: number, response: unknown) => {
              await this.prisma.idempotencyKey.update({
                where: { key },
                data: {
                  statusCode,
                  response: (response ?? {}) as never,
                },
              });
            };

            return next.handle().pipe(
              mergeMap(async (response) => {
                // These idempotent routes are POSTs with Nest's default 201.
                // The interceptor observes the handler result before Nest's
                // response controller writes the final status to Express.
                const successStatus = req.method === 'POST' ? 201 : 200;
                await persist(successStatus, response);
                return response;
              }),
              catchError((err: unknown) => {
                // M4: a crash (not an HTTP answer) used to leave the key at
                // 202 for ever. It ends in a final 500 instead. The action may
                // have happened, so the same key never runs it again.
                const [status, body] =
                  err instanceof HttpException ? [err.getStatus(), err.getResponse()] : [CRASHED.statusCode, CRASHED];
                return from(persist(status, body).catch(() => undefined)).pipe(
                  mergeMap(() => throwError(() => err)),
                );
              }),
            );
          }),
        );
      }),
    );
  }
}

/** Marks a route as requiring an Idempotency-Key. */
export const IDEMPOTENT = 'idempotent';
