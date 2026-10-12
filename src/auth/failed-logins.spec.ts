import { Prisma } from '@prisma/client';
import { LOCKOUT_MINUTES, MAX_FAILED_LOGINS, recordFailedLogin } from './failed-logins';

/**
 * Captures the statements; the real locking and its concurrency are proven on
 * Postgres by scripts/prove-login-lockout.ts.
 */
function fakeDb(row: { failedLogins: number; lockedUntil: Date | null; now: Date } | undefined) {
  const reads: Prisma.Sql[] = [];
  const writes: Prisma.Sql[] = [];
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      reads.push(Prisma.sql(strings, ...(values as Prisma.Sql[])));
      return row ? [row] : [];
    }),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      writes.push(Prisma.sql(strings, ...(values as Prisma.Sql[])));
      return 1;
    }),
  };
  const db = { $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
  return { db, reads, writes };
}

const NOW = new Date('2026-10-12T12:00:00Z');
const MIN = 60_000;

describe('recordFailedLogin', () => {
  it('keeps the existing policy: five failures, fifteen minutes', () => {
    expect(MAX_FAILED_LOGINS).toBe(5);
    expect(LOCKOUT_MINUTES).toBe(15);
  });

  it('locks the row first, then writes, in one transaction against the table it is given', async () => {
    const { db, reads, writes } = fakeDb({ failedLogins: 0, lockedUntil: null, now: NOW });
    await recordFailedLogin(db as never, 'admin_users', 'admin-1');
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(reads[0].sql).toMatch(/FROM "admin_users"/);
    expect(reads[0].sql).toMatch(/FOR UPDATE/);
    expect(reads[0].sql).not.toMatch(/admin-1/);
    expect(reads[0].values).toContain('admin-1');
    expect(writes[0].sql).toMatch(/UPDATE "admin_users"/);
    await recordFailedLogin(db as never, 'users', 'user-1');
    expect(reads[1].sql).toMatch(/FROM "users"/);
  });

  it('counts below the threshold without locking', async () => {
    const { db } = fakeDb({ failedLogins: 2, lockedUntil: null, now: NOW });
    await expect(recordFailedLogin(db as never, 'users', 'u')).resolves.toEqual({ failedLogins: 3, lockedUntil: null, justLocked: false });
  });

  it('locks for fifteen minutes on the fifth failure, and says this failure did it', async () => {
    const { db, writes } = fakeDb({ failedLogins: 4, lockedUntil: null, now: NOW });
    const until = new Date(NOW.getTime() + 15 * MIN);
    await expect(recordFailedLogin(db as never, 'users', 'u')).resolves.toEqual({ failedLogins: 5, lockedUntil: until, justLocked: true });
    expect(writes[0].values).toEqual(expect.arrayContaining([5, until]));
  });

  it('does not extend or re-announce a lock that is still running', async () => {
    const running = new Date(NOW.getTime() + 10 * MIN);
    const { db } = fakeDb({ failedLogins: 6, lockedUntil: running, now: NOW });
    await expect(recordFailedLogin(db as never, 'users', 'u')).resolves.toEqual({ failedLogins: 7, lockedUntil: running, justLocked: false });
  });

  it('starts a new lock when the old one has expired', async () => {
    const expired = new Date(NOW.getTime() - MIN);
    const { db } = fakeDb({ failedLogins: 10, lockedUntil: expired, now: NOW });
    const result = await recordFailedLogin(db as never, 'users', 'u');
    expect(result).toEqual({ failedLogins: 11, lockedUntil: new Date(NOW.getTime() + 15 * MIN), justLocked: true });
  });

  it('treats a vanished row as nothing recorded, and writes nothing', async () => {
    const { db, writes } = fakeDb(undefined);
    await expect(recordFailedLogin(db as never, 'users', 'gone')).resolves.toEqual({ failedLogins: 0, lockedUntil: null, justLocked: false });
    expect(writes).toHaveLength(0);
  });
});
