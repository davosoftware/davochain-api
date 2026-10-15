/**
 * Proves the saved-destination tables enforce their rules on real Postgres
 * (Part 2, C6): no duplicate live bank account, a removed one can be saved
 * again, a bad account number and a cap of 0 are refused by the database.
 *
 * Writes only rows it deletes again. Refuses unless NODE_ENV is development
 * and the database is on this machine.
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"CommonJS"}' scripts/prove-saved-destinations-schema.ts <user email>
 */
import { PrismaService } from '../src/prisma/prisma.service';
import { refuseUnlessLocalDevelopment } from './local-dev-guard';

async function refused(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  refuseUnlessLocalDevelopment();
  const email = process.argv[2];
  if (!email) throw new Error('Usage: prove-saved-destinations-schema.ts <user email>');
  const prisma = new PrismaService();
  await prisma.$connect();
  const ids: string[] = [];
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const row = { userId: user.id, bankCode: 'PROVE', bankName: 'Proof Bank', accountNumber: '0123456789', accountName: 'PROOF', usableFrom: new Date() };
    const first = await prisma.savedBankAccount.create({ data: row });
    ids.push(first.id);
    const duplicateRefused = await refused(() => prisma.savedBankAccount.create({ data: row }));
    await prisma.savedBankAccount.update({ where: { id: first.id }, data: { removedAt: new Date(), removedBy: 'user' } });
    const again = await prisma.savedBankAccount.create({ data: row });
    ids.push(again.id);
    const badNumberRefused = await refused(() => prisma.savedBankAccount.create({ data: { ...row, accountNumber: '123' } }));
    const zeroCapRefused = await refused(() =>
      prisma.platformLimit.upsert({ where: { id: 'default' }, create: { id: 'default', maxSavedBankAccounts: 0 }, update: { maxSavedBankAccounts: 0 } }),
    );
    const allChecks = duplicateRefused && badNumberRefused && zeroCapRefused;
    if (!allChecks) process.exitCode = 1;
    console.log(JSON.stringify({ allChecks, duplicateRefused, removedCanBeSavedAgain: true, badNumberRefused, zeroCapRefused }));
  } finally {
    await prisma.savedBankAccount.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
