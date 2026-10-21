/**
 * Proves only one Treasury move can be open at a time on real Postgres
 * (treasury spec §3.4): two "send to Quidax" requests at the same moment →
 * exactly one move is written and sent; the other is refused.
 *
 * The rail is stubbed (no Payrep call; it answers "pending"). Uses the
 * local e2e owner for the password check (stubbed to pass). Restores the
 * settings and deletes the moves it made. Local development database only.
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"CommonJS"}' scripts/prove-treasury-move-once.ts <owner admin email>
 */
import { AdminRole } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { TreasuryService } from '../src/treasury/treasury.service';
import { dec } from '../src/common/money';
import { refuseUnlessLocalDevelopment } from './local-dev-guard';

async function main(): Promise<void> {
  refuseUnlessLocalDevelopment();
  const email = process.argv[2];
  if (!email) throw new Error('Usage: prove-treasury-move-once.ts <owner admin email>');
  const prisma = new PrismaService();
  await prisma.$connect();
  const before = await prisma.treasurySettings.findUnique({ where: { id: 'default' } });
  const startedAt = new Date();
  try {
    const owner = await prisma.adminUser.findUniqueOrThrow({ where: { email } });
    await prisma.treasurySettings.update({
      where: { id: 'default' },
      data: { quidaxFundingBankCode: '058', quidaxFundingBankName: 'Proof Bank', quidaxFundingAccountNumber: '0123451234', quidaxFundingAccountName: 'PROOF' },
    });
    const rail = {
      name: 'Proof rail',
      balance: async () => ({ available: dec('100000000'), ledger: dec('100000000') }),
      banks: async () => [{ code: '058', name: 'Proof Bank' }],
      resolveAccount: async () => ({ accountName: 'PROOF' }),
      transfer: async (i: { reference: string }) => ({ id: 'proof', reference: i.reference, status: 'PENDING' as const, fee: null, reason: null }),
      transferStatus: async () => null,
    };
    const svc = new TreasuryService(
      prisma,
      rail,
      { inventory: async () => dec('0') } as never,
      { raise: async () => true } as never,
      undefined,
      { verify: async () => true } as never,
    );
    const actor = { id: owner.id, role: AdminRole.OWNER };
    const results = await Promise.allSettled([svc.sendToQuidax(actor, { amount: 1000, password: 'x' }), svc.sendToQuidax(actor, { amount: 1000, password: 'x' })]);
    const written = await prisma.treasuryMove.count({ where: { createdAt: { gte: startedAt }, createdBy: owner.id } });
    const refused = results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason?.message));
    const exactlyOne = written === 1 && refused.length === 1;
    if (!exactlyOne) process.exitCode = 1;
    console.log(JSON.stringify({ exactlyOneMove: exactlyOne, written, refusedWith: refused }));
  } finally {
    await prisma.treasuryMove.deleteMany({ where: { createdAt: { gte: startedAt } } });
    if (before) {
      const { id: _id, updatedAt: _u, ...rest } = before;
      await prisma.treasurySettings.update({ where: { id: 'default' }, data: rest });
    }
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
