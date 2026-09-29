import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from, of, switchMap, tap } from 'rxjs';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
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
  constructor(private readonly prisma: PrismaService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<{
      method: string;
      headers: Record<string, string | undefined>;
      body: unknown;
      user?: JwtPayload;
    }>();

    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next.handle();

    const key = req.headers['idempotency-key'];
    if (!key) {
      throw new BadRequestException('Idempotency-Key header is required for this request');
    }
    if (key.length > 200) throw new BadRequestException('Idempotency-Key is too long');

    const userId = req.user?.sub ?? 'anonymous';
    const requestHash = createHash('sha256')
      .update(JSON.stringify(req.body ?? {}))
      .digest('hex');

    return from(this.prisma.idempotencyKey.findUnique({ where: { key } })).pipe(
      switchMap((existing) => {
        if (existing) {
          if (existing.userId !== userId || existing.requestHash !== requestHash) {
            throw new ConflictException(
              'This Idempotency-Key was already used with a different request',
            );
          }
          return of(existing.response);
        }

        return next.handle().pipe(
          tap((response) => {
            void this.prisma.idempotencyKey
              .create({
                data: {
                  key,
                  userId,
                  requestHash,
                  statusCode: 200,
                  response: (response ?? {}) as never,
                },
              })
              // A racing duplicate hits the unique constraint; the winner's
              // response is already correct, so there is nothing to do.
              .catch(() => undefined);
          }),
        );
      }),
    );
  }
}

/** Marks a route as requiring an Idempotency-Key. */
export const IDEMPOTENT = 'idempotent';
