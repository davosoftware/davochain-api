/**
 * Proves the failed-login counter on real Postgres (spec §6): ten parallel
 * wrong passwords lock an account exactly once, at the fifth, and the count
 * ends at ten; a failure after an expired lock locks again, once.
 *
 * Uses an existing user and admin on the local dev database, saves their
 * counter and lock first, and puts both back afterwards.
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"CommonJS"}' scripts/prove-login-lockout.ts <user email> <admin email>
 */
import { PrismaClient } from '@prisma/client';
import { recordFailedLogin, LoginTable } from '../src/auth/failed-logins';
import { refuseUnlessLocalDevelopment } from './local-dev-guard';

const MINUTE = 60_000;

async function proveOne(prisma: PrismaClient, table: LoginTable, id: string) {
  const model = table === 'users' ? prisma.user : prisma.adminUser;
  const saved = await (model as typeof prisma.user).findUniqueOrThrow({ where: { id }, select: { failedLogins: true, lockedUntil: true } });
  try {
    await (model as typeof prisma.user).update({ where: { id }, data: { failedLogins: 0, lockedUntil: null } });
    const burst = await Promise.all(Array.from({ length: 10 }, () => recordFailedLogin(prisma, table, id)));
    const locks = burst.filter((r) => r.justLocked);
    const after = await (model as typeof prisma.user).findUniqueOrThrow({ where: { id }, select: { failedLogins: true, lockedUntil: true } });
    const minutesAhead = after.lockedUntil ? (after.lockedUntil.getTime() - Date.now()) / MINUTE : -1;

    // An expired lock, then one more failure: a fresh lock, reported once.
    await (model as typeof prisma.user).update({ where: { id }, data: { lockedUntil: new Date(Date.now() - MINUTE) } });
    const relock = await recordFailedLogin(prisma, table, id);

    return {
      table,
      lockedExactlyOnce: locks.length === 1,
      lockedAtTheFifth: locks[0]?.failedLogins === 5,
      countIsTen: after.failedLogins === 10,
      lockIsFifteenMinutes: minutesAhead > 14 && minutesAhead <= 15.1,
      expiredLockRelocks: relock.justLocked && relock.failedLogins === 11,
    };
  } finally {
    await (model as typeof prisma.user).update({ where: { id }, data: saved });
  }
}

async function main(): Promise<void> {
  refuseUnlessLocalDevelopment();
  const [userEmail, adminEmail] = process.argv.slice(2);
  if (!userEmail || !adminEmail) throw new Error('Usage: prove-login-lockout.ts <user email> <admin email>');
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: userEmail }, select: { id: true } });
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: adminEmail }, select: { id: true } });
    const results = [await proveOne(prisma, 'users', user.id), await proveOne(prisma, 'admin_users', admin.id)];
    const proven = results.every((r) => Object.entries(r).every(([k, v]) => k === 'table' || v === true));
    if (!proven) process.exitCode = 1;
    console.log(JSON.stringify(results));
  } finally {
    await prisma.$disconnect();
  }
}

void main();
