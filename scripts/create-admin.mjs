#!/usr/bin/env node
/**
 * Create an admin account.
 *
 * Without one, nobody can reach /v1/admin — which means KYC can never be
 * approved, which means no user can ever trade. The bootstrap has to live
 * outside the API, because the API itself is what it unlocks.
 *
 *   npm run create-admin -- --email you@example.com
 *   npm run create-admin -- --email you@example.com --password 'correct horse battery'
 *
 * With no --password a strong one is generated and printed ONCE. It is never
 * written to disk or logged anywhere else.
 *
 * Re-running for an existing email resets that admin's password rather than
 * failing, so a forgotten password is recoverable without touching the database.
 */
import { PrismaClient } from '@prisma/client';
import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// Must match src/auth/password.service.ts exactly, or the hash will not verify.
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 96 * 1024 * 1024;

async function hash(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return ['scrypt', N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

/** Readable but high-entropy: ~62 bits over four words plus digits. */
function generatePassword() {
  return randomBytes(18).toString('base64url');
}

async function main() {
  const email = (arg('email') ?? process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const name = arg('name') ?? process.env.ADMIN_NAME ?? 'Administrator';
  const supplied = arg('password') ?? process.env.ADMIN_PASSWORD;

  if (!email || !email.includes('@')) {
    console.error('\n  Usage: npm run create-admin -- --email you@example.com [--password ...]\n');
    process.exit(1);
  }

  if (supplied && supplied.length < 12) {
    console.error('\n  Password must be at least 12 characters.\n');
    process.exit(1);
  }

  const password = supplied ?? generatePassword();
  const passwordHash = await hash(password);
  const prisma = new PrismaClient();

  try {
    const existing = await prisma.adminUser.findUnique({ where: { email } });

    const admin = await prisma.adminUser.upsert({
      where: { email },
      // OWNER, always. This script exists to bootstrap the account that can
      // grant every other one — a sub-admin with no permissions could not
      // unlock anything, including itself.
      create: { email, name, passwordHash, isActive: true, role: 'OWNER' },
      // passwordChangedAt revokes every token issued before now. A reset from
      // here is usually a reset because control of the account was lost, which
      // is precisely when the sessions already open must not survive it.
      // Deliberately does not touch role or permissions: this is also the
      // forgotten-password path, and a reset should not quietly promote.
      update: { passwordHash, isActive: true, passwordChangedAt: new Date() },
    });

    const action = existing ? 'Password reset for' : 'Created admin';
    console.log(`\n  ${action} ${admin.email}`);

    if (supplied) {
      console.log('  Password: (the one you supplied)\n');
    } else {
      console.log('\n  Password (shown once — copy it now):\n');
      console.log(`      ${password}\n`);
    }

    console.log('  Sign in:');
    console.log(`      POST /v1/admin/auth/login  { "email": "${admin.email}", "password": "..." }\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`\n  Failed: ${err.message}\n`);
  process.exit(1);
});
