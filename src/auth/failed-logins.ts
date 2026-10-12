import { Prisma, PrismaClient } from '@prisma/client';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;

export type LoginTable = 'users' | 'admin_users';

export interface FailedLogin {
  failedLogins: number;
  lockedUntil: Date | null;
  /** True for exactly the one failure that started this lock. */
  justLocked: boolean;
}

const TABLES: Record<LoginTable, Prisma.Sql> = {
  users: Prisma.raw('"users"'),
  admin_users: Prisma.raw('"admin_users"'),
};

type Tx = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

/**
 * Count a wrong password and lock on the fifth (spec §4.1).
 *
 * The old read-then-write let ten parallel guesses all read "3" and all write
 * "4", so the lock never came. Here the row is locked first (FOR UPDATE), so
 * parallel failures on one account run one after another, each seeing what the
 * last one wrote. That makes exactly one of them the fifth, and exactly one
 * report `justLocked`, which is what the admin audit and alert key on.
 *
 * Two statements, deliberately: a single UPDATE with a FOR UPDATE CTE reads
 * the row as of the statement's start, so every waiter saw "no lock yet" and
 * claimed the lock as its own (found by scripts/prove-login-lockout.ts).
 *
 * A failure during a running lock neither extends nor re-announces it; one
 * after it has expired starts a new one. Times come from the database clock,
 * in UTC like every Prisma DateTime column.
 */
export async function recordFailedLogin(
  prisma: { $transaction: PrismaClient['$transaction'] },
  table: LoginTable,
  id: string,
): Promise<FailedLogin> {
  const t = TABLES[table];
  return prisma.$transaction(async (tx: Tx) => {
    const rows = await tx.$queryRaw<Array<{ failedLogins: number; lockedUntil: Date | null; now: Date }>>`
      SELECT "failedLogins", "lockedUntil", (now() AT TIME ZONE 'UTC') AS "now"
      FROM ${t} WHERE "id" = ${id} FOR UPDATE`;
    const row = rows[0];
    if (!row) return { failedLogins: 0, lockedUntil: null, justLocked: false };

    const failedLogins = Number(row.failedLogins) + 1;
    const lockRunning = row.lockedUntil !== null && row.lockedUntil > row.now;
    const justLocked = failedLogins >= MAX_FAILED_LOGINS && !lockRunning;
    const lockedUntil = justLocked ? new Date(row.now.getTime() + LOCKOUT_MINUTES * 60_000) : row.lockedUntil;

    await tx.$executeRaw`
      UPDATE ${t} SET "failedLogins" = ${failedLogins}, "lockedUntil" = ${lockedUntil} WHERE "id" = ${id}`;
    return { failedLogins, lockedUntil, justLocked };
  });
}
