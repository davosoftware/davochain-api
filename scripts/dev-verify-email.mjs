#!/usr/bin/env node
/**
 * Mark a customer's email as confirmed, for local testing only (H9).
 *
 *   node scripts/dev-verify-email.mjs --email ada@example.com
 *   node scripts/dev-verify-email.mjs --email ada@example.com --set-code 424242
 *
 * --set-code replaces the newest open emailed code with a known one, so a test
 * can type it into POST /v1/auth/email/verify like a customer would.
 *
 * Stands in for typing the emailed six-digit code, so tests and local runs
 * don't need a real inbox. REFUSES to run when NODE_ENV=production.
 */
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
};

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('\n  Refusing to run in production. Customers confirm their own email.\n');
    process.exit(1);
  }
  const email = arg('email');
  if (!email) {
    console.error('\n  Usage: node scripts/dev-verify-email.mjs --email you@example.com\n');
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    const known = arg('set-code');
    if (known !== undefined) {
      if (!/^\d{6}$/.test(known)) {
        console.error('\n  --set-code needs six digits\n');
        process.exit(1);
      }
      const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true } });
      const open = user && (await prisma.userOtp.findFirst({
        where: { userId: user.id, purpose: 'EMAIL_VERIFY', consumedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      }));
      if (!open) {
        console.error(`\n  No open email code for ${email}\n`);
        process.exit(1);
      }
      await prisma.userOtp.update({ where: { id: open.id }, data: { codeHash: createHash('sha256').update(known).digest('hex') } });
      console.log(`\n  Email code for ${email} set\n`);
      return;
    }
    const r = await prisma.user.updateMany({
      where: { email: email.toLowerCase(), emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true } });
    if (!user) {
      console.error(`\n  No user with email ${email}\n`);
      process.exit(1);
    }
    console.log(r.count ? `\n  Email confirmed for ${email}\n` : `\n  ${email} was already confirmed\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
