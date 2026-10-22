#!/usr/bin/env node
/**
 * Mark a customer's email as confirmed, for local testing only (H9).
 *
 *   node scripts/dev-verify-email.mjs --email ada@example.com
 *
 * Stands in for typing the emailed six-digit code, so tests and local runs
 * don't need a real inbox. REFUSES to run when NODE_ENV=production.
 */
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
