import { BadRequestException, HttpException } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';

/**
 * M4 (PROJECT_REVIEW):
 *  - keys were global, so user B reusing user A's key got a conflict, and could
 *    probe which keys A had used. A key now belongs to one user;
 *  - a crash (not an HTTP error) left the key at "still processing" for ever,
 *    so every retry got 409 with nothing to go on. It now ends in a final 500
 *    that says to check history: the action may have happened, so the same key
 *    never runs it again;
 *  - keys were never deleted. A cleanup removes keys older than seven days.
 */
function db() {
  const rows = new Map<string, { key: string; userId: string; requestHash: string; statusCode: number; response: unknown; createdAt: Date }>();
  const prisma = {
    idempotencyKey: {
      findUnique: jest.fn(async ({ where }: { where: { key: string } }) => rows.get(where.key) ?? null),
      create: jest.fn(async ({ data }: { data: { key: string; userId: string; requestHash: string; statusCode: number; response: unknown } }) => {
        if (rows.has(data.key)) throw Object.assign(new Error('unique'), { code: 'P2002' });
        rows.set(data.key, { ...data, createdAt: new Date() });
        return data;
      }),
      update: jest.fn(async ({ where, data }: { where: { key: string }; data: Record<string, unknown> }) => Object.assign(rows.get(where.key)!, data)),
      deleteMany: jest.fn(async ({ where }: { where: { createdAt: { lt: Date } } }) => {
        let count = 0;
        for (const [k, r] of rows) if (r.createdAt < where.createdAt.lt) (rows.delete(k), count++);
        return { count };
      }),
    },
  };
  return { rows, prisma };
}

function ctx(userId: string, key: string, body: unknown = { amount: '1' }) {
  const res = { statusCode: 0, status(code: number) { this.statusCode = code; } };
  return {
    res,
    ctx: {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'POST', headers: { 'idempotency-key': key }, body, user: { sub: userId } }),
        getResponse: () => res,
      }),
    } as never,
  };
}
const run = (i: IdempotencyInterceptor, c: unknown, handler: () => unknown) =>
  lastValueFrom(i.intercept(c as never, { handle: () => handler() as never }));

describe('M4: idempotency keys', () => {
  it('replays the first result for the same user, key and body', async () => {
    const { prisma } = db();
    const i = new IdempotencyInterceptor(prisma as never);
    const handler = jest.fn(() => of({ id: 'tx1' }));
    await run(i, ctx('a', 'k1').ctx, handler);
    await expect(run(i, ctx('a', 'k1').ctx, handler)).resolves.toEqual({ id: 'tx1' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('another user using the same key is a separate request, not a conflict', async () => {
    const { prisma } = db();
    const i = new IdempotencyInterceptor(prisma as never);
    await run(i, ctx('a', 'shared').ctx, () => of({ id: 'tx-a' }));
    await expect(run(i, ctx('b', 'shared').ctx, () => of({ id: 'tx-b' }))).resolves.toEqual({ id: 'tx-b' });
  });

  it('a crash ends in a final answer, not "still processing" for ever, and does not run again', async () => {
    const { prisma } = db();
    const i = new IdempotencyInterceptor(prisma as never);
    await expect(run(i, ctx('a', 'k2').ctx, () => throwError(() => new Error('connection reset')))).rejects.toThrow('connection reset');
    const handler = jest.fn(() => of({ id: 'never' }));
    const replay = await run(i, ctx('a', 'k2').ctx, handler).catch((e) => e);
    expect(handler).not.toHaveBeenCalled();
    expect(replay).toBeInstanceOf(HttpException);
    expect((replay as HttpException).getStatus()).toBe(500);
    expect(JSON.stringify((replay as HttpException).getResponse())).toContain('Check your history');
  });

  it('an HTTP error is replayed as it was', async () => {
    const { prisma } = db();
    const i = new IdempotencyInterceptor(prisma as never);
    await run(i, ctx('a', 'k3').ctx, () => throwError(() => new BadRequestException('Insufficient balance'))).catch(() => undefined);
    const replay = await run(i, ctx('a', 'k3').ctx, () => of({})).catch((e) => e);
    expect((replay as HttpException).getStatus()).toBe(400);
  });

  it('removes keys older than seven days', async () => {
    const { prisma, rows } = db();
    const i = new IdempotencyInterceptor(prisma as never);
    await run(i, ctx('a', 'old').ctx, () => of({}));
    await run(i, ctx('a', 'new').ctx, () => of({}));
    [...rows.values()][0].createdAt = new Date(Date.now() - 8 * 86_400_000);
    expect(await i.cleanup()).toBe(1);
    expect(rows.size).toBe(1);
  });
});
