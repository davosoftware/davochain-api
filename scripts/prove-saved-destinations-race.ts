/**
 * Proves the saved-bank-account cap holds under a race on real Postgres
 * (Part 2, C6): with one slot left, six "add" requests at once save exactly one.
 *
 * Temporarily sets the cap to (the user's live count + 1) and puts it back;
 * deletes the rows it created. The bank lookup and the password check are
 * stubbed (no Quidax call). Refuses unless NODE_ENV is development and the
 * database is on this machine.
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"CommonJS"}' scripts/prove-saved-destinations-race.ts <user email>
 */
import { PrismaService } from '../src/prisma/prisma.service';
import { SavedDestinationsService } from '../src/withdrawals/saved-destinations.service';
import { refuseUnlessLocalDevelopment } from './local-dev-guard';

async function main(): Promise<void> {
  refuseUnlessLocalDevelopment();
  const email = process.argv[2];
  if (!email) throw new Error('Usage: prove-saved-destinations-race.ts <user email>');
  const prisma = new PrismaService();
  await prisma.$connect();
  const before = await prisma.platformLimit.findUnique({ where: { id: 'default' } });
  const startedAt = new Date();
  let userId = '';
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    userId = user.id;
    const live = await prisma.savedBankAccount.count({ where: { userId, removedAt: null } });
    await prisma.platformLimit.upsert({ where: { id: 'default' }, create: { id: 'default', maxSavedBankAccounts: live + 1 }, update: { maxSavedBankAccounts: live + 1 } });

    const svc = new SavedDestinationsService(
      prisma,
      { verify: async () => true } as never,
      { lookupNgnBankAccount: async () => ({ bankName: 'Proof Bank', accountName: 'PROOF' }) } as never,
      { notify: async () => undefined } as never,
    );
    const racers = 6;
    const results = await Promise.allSettled(
      Array.from({ length: racers }, (_, i) => svc.addBank(userId, { bankCode: 'PROVE', accountNumber: `09000000${String(i).padStart(2, '0')}`, password: 'x' })),
    );
    const saved = await prisma.savedBankAccount.count({ where: { userId, bankCode: 'PROVE', createdAt: { gte: startedAt } } });
    const refused = [...new Set(results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason?.message)))];
    const exactlyOneSaved = saved === 1;
    if (!exactlyOneSaved) process.exitCode = 1;
    console.log(JSON.stringify({ racers, exactlyOneSaved, saved, refusedWith: refused }));
  } finally {
    if (userId) await prisma.savedBankAccount.deleteMany({ where: { userId, bankCode: 'PROVE', createdAt: { gte: startedAt } } });
    await prisma.platformLimit.update({ where: { id: 'default' }, data: { maxSavedBankAccounts: before?.maxSavedBankAccounts ?? 5 } });
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
