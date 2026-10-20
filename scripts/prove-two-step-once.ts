/**
 * Proves on real Postgres (M7, spec §3) that two right second-step codes at the
 * same moment sign in exactly once, and that a backup code works once even
 * when it is sent twice at the same moment.
 *
 * Creates a throwaway admin (proof-two-step-…@davochain.invalid), deletes it
 * (and with it its codes and challenges) at the end. Mail is not sent. Local
 * development database only.
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"CommonJS"}' scripts/prove-two-step-once.ts
 */
import { AdminChallengeKind, AdminOtpPurpose, AdminRole } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AdminOtpService } from '../src/admin/otp.service';
import { TwoStepService } from '../src/admin/two-step.service';
import { refuseUnlessLocalDevelopment } from './local-dev-guard';

const ROUNDS = 20;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function main(): Promise<void> {
  refuseUnlessLocalDevelopment();
  const prisma = new PrismaService();
  await prisma.$connect();
  const admin = await prisma.adminUser.create({
    data: { email: `proof-two-step-${randomUUID()}@davochain.invalid`, name: 'Proof Admin', passwordHash: 'x', role: AdminRole.SUB_ADMIN, twoStepEnabled: true },
  });
  const otps = new AdminOtpService(prisma, { send: async () => false } as never, { render: async () => null } as never);
  const svc = new TwoStepService(prisma, otps, { verify: async () => true } as never, { get: async () => false } as never, { revokeAllFor: async () => 0 } as never, { raise: async () => true } as never);
  const broken: string[] = [];
  try {
    for (let i = 0; i < ROUNDS; i++) {
      // An emailed code: set a known one directly (mail is not sent here).
      await prisma.adminOtp.updateMany({ where: { adminUserId: admin.id, consumedAt: null }, data: { consumedAt: new Date() } });
      await prisma.adminOtp.create({ data: { adminUserId: admin.id, purpose: AdminOtpPurpose.LOGIN, codeHash: sha('424242'), expiresAt: new Date(Date.now() + 600_000) } });
      const { ticket } = await svc.startChallenge(admin, AdminChallengeKind.CODE);
      const both = await Promise.allSettled([svc.verifyLogin(ticket, '424242'), svc.verifyLogin(ticket, '424242')]);
      const ok = both.filter((r) => r.status === 'fulfilled').length;
      if (ok !== 1) broken.push(`emailed code round ${i}: ${ok} sign-ins`);
    }
    for (let i = 0; i < ROUNDS; i++) {
      const codes = await svc.generateBackupCodes(prisma, admin.id);
      const [t1, t2] = [await svc.startChallenge(admin, AdminChallengeKind.CODE), await svc.startChallenge(admin, AdminChallengeKind.CODE)];
      const both = await Promise.allSettled([svc.verifyLogin(t1.ticket, codes[0]), svc.verifyLogin(t2.ticket, codes[0])]);
      const ok = both.filter((r) => r.status === 'fulfilled').length;
      if (ok !== 1) broken.push(`backup code round ${i}: ${ok} sign-ins`);
    }
    console.log(`Rounds: ${ROUNDS} with the same emailed code twice, ${ROUNDS} with the same backup code on two sign-ins.`);
    if (broken.length) {
      console.error(`FAILED:\n${broken.join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log('PROVED: every round signed in exactly once; no code worked twice.');
    }
  } finally {
    await prisma.adminUser.delete({ where: { id: admin.id } });
    await prisma.$disconnect();
  }
}

void main();
