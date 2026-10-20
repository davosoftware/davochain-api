#!/usr/bin/env node
/**
 * Test helper for the admin two-step sign-in end-to-end suite (M7). Local
 * development only: REFUSES NODE_ENV=production and any database that is not
 * on this machine.
 *
 * The e2e server has no mail server, so the emailed codes cannot be read.
 * This sets a known code on the newest open one instead, and prepares or
 * resets the dedicated test admin, so the main e2e owner is never touched.
 *
 *   node scripts/e2e-admin-two-step.mjs --ensure e2e-twostep@davochain.invalid --password '...'
 *   node scripts/e2e-admin-two-step.mjs --code e2e-twostep@davochain.invalid --purpose LOGIN --value 424242
 *   node scripts/e2e-admin-two-step.mjs --clear-flag
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
};
const has = (name) => process.argv.includes(`--${name}`);
const sha = (s) => createHash('sha256').update(s).digest('hex');

// Must match src/auth/password.service.ts (same as scripts/create-admin.mjs).
async function hash(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
  return ['scrypt', 2 ** 15, 8, 1, salt.toString('base64'), derived.toString('base64')].join('$');
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run in production.');
  const url = process.env.DATABASE_URL ?? '';
  if (url && !/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) throw new Error('Refusing: DATABASE_URL is not a local database.');

  const prisma = new PrismaClient();
  try {
    if (has('clear-flag')) {
      await prisma.systemFlag.upsert({
        where: { key: 'admin_two_step_required' },
        create: { key: 'admin_two_step_required', value: false, updatedBy: 'e2e' },
        update: { value: false, updatedBy: 'e2e' },
      });
    }

    const ensure = arg('ensure');
    if (ensure) {
      const email = ensure.trim().toLowerCase();
      if (!email.endsWith('@davochain.invalid')) throw new Error('Only @davochain.invalid test admins.');
      const passwordHash = await hash(arg('password') ?? '');
      const admin = await prisma.adminUser.upsert({
        where: { email },
        create: { email, name: 'E2E Two-Step', passwordHash, role: 'OWNER', isActive: true },
        update: { passwordHash, isActive: true, twoStepEnabled: false, twoStepEnabledAt: null, failedLogins: 0, lockedUntil: null, passwordChangedAt: new Date() },
      });
      await prisma.adminBackupCode.deleteMany({ where: { adminUserId: admin.id } });
      await prisma.adminLoginChallenge.deleteMany({ where: { adminUserId: admin.id } });
      await prisma.adminOtp.deleteMany({ where: { adminUserId: admin.id } });
    }

    const codeFor = arg('code');
    if (codeFor) {
      const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: codeFor.trim().toLowerCase() } });
      const purpose = arg('purpose');
      const value = arg('value');
      if (!['LOGIN', 'TWO_STEP_CHANGE'].includes(purpose ?? '') || !/^\d{6}$/.test(value ?? '')) throw new Error('--purpose LOGIN|TWO_STEP_CHANGE --value 6 digits');
      const open = await prisma.adminOtp.findFirst({ where: { adminUserId: admin.id, purpose, consumedAt: null }, orderBy: { createdAt: 'desc' } });
      if (!open) throw new Error(`No open ${purpose} code for ${admin.email}`);
      await prisma.adminOtp.update({ where: { id: open.id }, data: { codeHash: sha(value) } });
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`  e2e-admin-two-step: ${err.message}`);
  process.exit(1);
});
