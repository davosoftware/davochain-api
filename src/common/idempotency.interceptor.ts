import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, from, mergeMap, of, switchMap, throwError } from 'rxjs';
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
                if (!(err instanceof HttpException)) return throwError(() => err);
                return from(persist(err.getStatus(), err.getResponse())).pipe(
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
