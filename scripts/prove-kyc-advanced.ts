/**
 * Proves on real Postgres (spec 2026-10-21 §8, §11) that two admins deciding the
 * same Advanced check at the same moment, one approving and one rejecting,
 * end with exactly one decision: one winner, one audit row, and a level that
 * matches the winner (TIER_2 if and only if approved).
 *
 * Creates throwaway customers (proof-adv-…@davochain.invalid) and deletes them
 * at the end. No mail is sent. Local development database only.
 *
 * Run: TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' npx ts-node --transpile-only scripts/prove-kyc-advanced.ts
 */
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AdvancedApprover } from '../src/kyc/advanced/advanced-approver';
import { AdvancedReviewService } from '../src/kyc/advanced/advanced-review.service';
import { refuseUnlessLocalDevelopment } from './local-dev-guard';

const ROUNDS = 40;

async function main(): Promise<void> {
  refuseUnlessLocalDevelopment();
  const prisma = new PrismaService();
  await prisma.$connect();
  const approver = new AdvancedApprover(prisma, { send: async () => undefined } as never, { onKycChanged: async () => undefined } as never);
  const review = new AdvancedReviewService(prisma, approver, {} as never);
  const admins = await prisma.adminUser.findMany({ take: 2, select: { id: true } });
  if (admins.length < 2) throw new Error('Needs two admin rows in the local database (any two) for the audit foreign key.');
  const made: string[] = [];
  const broken: string[] = [];
  let approvedWins = 0;
  try {
    for (let i = 0; i < ROUNDS; i++) {
      const u = await prisma.user.create({
        data: { email: `proof-adv-${randomUUID()}@davochain.invalid`, passwordHash: 'x', firstName: 'Proof', lastName: 'Advanced', isTest: true, kycTier: 'TIER_1', kycStatus: 'APPROVED', amlStatus: 'CLEAR' },
      });
      made.push(u.id);
      await prisma.kycProfile.create({ data: { userId: u.id, tier: 'TIER_1', status: 'APPROVED' } });
      const v = await prisma.advancedVerification.create({
        data: { userId: u.id, step: 'IDENTITY', activeFor: u.id, lagosDay: '2026-10-21', state: 'IN_REVIEW', idType: 'NATIONAL_ID', reviewReasons: ['FACE_MATCH_BORDERLINE'] },
      });
      // Approve first in even rounds, reject first in odd ones, so neither side always starts ahead.
      const approve = () => review.decide({ adminId: admins[0].id }, v.id, { approve: true, reason: 'APPROVED_AFTER_REVIEW' });
      const reject = () => review.decide({ adminId: admins[1].id }, v.id, { approve: false, reason: 'DOC_UNCLEAR' });
      const both = await Promise.allSettled(i % 2 ? [reject(), approve()] : [approve(), reject()]);
      const wins = both.filter((r) => r.status === 'fulfilled').length;
      const after = await prisma.advancedVerification.findUniqueOrThrow({ where: { id: v.id } });
      const user = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      const audits = await prisma.adminAuditLog.count({ where: { entity: 'AdvancedVerification', entityId: v.id } });
      if (wins !== 1) broken.push(`round ${i}: ${wins} decisions succeeded`);
      if ((after.state === 'APPROVED') !== (user.kycTier === 'TIER_2')) broken.push(`round ${i}: state ${after.state} but level ${user.kycTier}`);
      if (audits !== 1) broken.push(`round ${i}: ${audits} audit rows`);
      if (after.activeFor !== null) broken.push(`round ${i}: slot still held`);
      if (after.state === 'APPROVED') approvedWins++;
    }
    console.log(`Rounds: ${ROUNDS}. Approve won ${approvedWins}, reject won ${ROUNDS - approvedWins}.`);
    console.log(`exactlyOneWinner: ${!broken.some((b) => b.includes('decisions'))}`);
    console.log(`levelsConsistent: ${!broken.some((b) => b.includes('level'))}`);
    console.log(`auditOnePerRow: ${!broken.some((b) => b.includes('audit'))}`);
    if (broken.length) {
      console.error(`FAILED:\n${broken.join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log('PROVED: every round had exactly one decision, one audit row, and a matching level.');
    }
  } finally {
    for (const id of made) {
      const rows = await prisma.advancedVerification.findMany({ where: { userId: id }, select: { id: true } });
      await prisma.adminAuditLog.deleteMany({ where: { entity: 'AdvancedVerification', entityId: { in: rows.map((r) => r.id) } } });
      await prisma.advancedVerification.deleteMany({ where: { userId: id } });
      await prisma.kycProfile.deleteMany({ where: { userId: id } });
      await prisma.user.delete({ where: { id } }).catch((e: Error) => console.error(`could not delete proof user ${id}: ${e.message}`));
    }
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
