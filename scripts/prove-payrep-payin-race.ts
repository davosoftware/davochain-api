/**
 * Proves on real Postgres (spec 2026-10-20 §6, plan Review Focus 5) that one
 * Payrep deposit reported three times at the same moment (webhook, sweep and
 * re-check all at once) is credited exactly once: one transaction, one set of
 * ledger entries, and a balance equal to the deposit.
 *
 * Uses the pretend Payrep (no network), creates a throwaway customer
 * (proof-payrep-…@davochain.invalid) and deletes everything at the end. No mail
 * is sent. Local development database only.
 *
 * Run: TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' npx ts-node --transpile-only scripts/prove-payrep-payin-race.ts
 */
import { randomInt, randomUUID } from 'node:crypto';
import { dec } from '../src/common/money';
import { LedgerService } from '../src/ledger/ledger.service';
import { PayInService } from '../src/ngn-deposits/pay-in.service';
import { VirtualAccountsService } from '../src/ngn-deposits/virtual-accounts.service';
import { PayrepMock } from '../src/payrep/payrep.mock';
import { PrismaService } from '../src/prisma/prisma.service';
import { refuseUnlessLocalDevelopment } from './local-dev-guard';

const ROUNDS = 40;
const RUNS_AT_ONCE = 3;

async function main(): Promise<void> {
  refuseUnlessLocalDevelopment();
  const prisma = new PrismaService();
  await prisma.$connect();
  const payrep = new PayrepMock({ port: 1 });
  // The webhook is not needed here: the proof calls the intake directly.
  (payrep as unknown as { deliver: () => Promise<number> }).deliver = async () => 200;
  const alerts = { raise: async () => true };
  const accounts = new VirtualAccountsService(prisma, payrep, { mainAccount: '7801234567' } as never, {} as never, {} as never, alerts as never);
  const ledger = new LedgerService(prisma);
  const kycLimits = { fx: async () => ({ ngnPerUsd: '1500' }), checkInTransaction: async () => ({ allowed: true }) };
  const quiet = { notify: async () => undefined };
  const rates = { price: async () => ({ ngnPerUsd: dec('1500') }) };
  const queue = { add: async () => undefined };
  const payIn = new PayInService(prisma, payrep, accounts, ledger, kycLimits as never, quiet as never, rates as never, alerts as never, queue as never);

  const accountNumber = `29${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
  const user = await prisma.user.create({
    data: { email: `proof-payrep-${randomUUID()}@davochain.invalid`, passwordHash: 'x', firstName: 'Proof', lastName: 'Payrep', isTest: true, kycTier: 'TIER_1', kycStatus: 'APPROVED', amlStatus: 'CLEAR' },
  });
  const ids: string[] = [];
  const broken: string[] = [];
  let expected = dec(0);
  try {
    await prisma.virtualAccount.create({
      data: { userId: user.id, accountNumber, accountName: 'Proof Payrep', bankName: 'Payrep MFB', isPrimary: true, source: 'CREATED', providerStatus: 'active' },
    });
    for (let i = 0; i < ROUNDS; i++) {
      const amount = `${100 + i}.${String(i % 100).padStart(2, '0')}`;
      const { transactionId } = await payrep.simulateDeposit({ accountNumber, amount, fee: '1.00', senderName: 'PROOF PAYREP' });
      ids.push(transactionId);
      await payIn.intake({ transactionId, accountNumber, referenceNumber: null, createdAt: new Date().toISOString(), event: 'deposit.success' }, 'WEBHOOK');
      const runs = await Promise.allSettled(Array.from({ length: RUNS_AT_ONCE }, () => payIn.processPayment(transactionId)));
      const changed = runs.filter((r) => r.status === 'fulfilled' && r.value.changed).length;
      // A run that lost the race may throw "retrying"; the job queue would run it again. Do that once here.
      if (runs.some((r) => r.status === 'rejected')) await payIn.processPayment(transactionId).catch(() => undefined);
      const txs = await prisma.transaction.findMany({ where: { reference: `payrep:payin:${transactionId}` } });
      const entries = txs.length === 1 ? await prisma.ledgerEntry.count({ where: { transactionId: txs[0].id } }) : -1;
      const row = await prisma.nairaCollection.findUniqueOrThrow({ where: { providerTransactionId: transactionId } });
      if (txs.length !== 1) broken.push(`round ${i}: ${txs.length} transactions`);
      if (entries !== 3) broken.push(`round ${i}: ${entries} ledger entries (expected 3)`);
      if (changed > 1) broken.push(`round ${i}: ${changed} runs said they credited`);
      if (row.outcome !== 'CREDITED') broken.push(`round ${i}: outcome ${row.outcome}`);
      expected = expected.plus(amount);
    }
    const balance = await prisma.balance.findUnique({ where: { userId_assetCode: { userId: user.id, assetCode: 'ngn' } } });
    const got = dec(balance?.available ?? 0);
    if (!got.eq(expected)) broken.push(`balance ${got.toFixed()} but deposits total ${expected.toFixed()}`);

    console.log(`Rounds: ${ROUNDS}, ${RUNS_AT_ONCE} runs at once each. Balance ₦${got.toFixed()} for deposits totalling ₦${expected.toFixed()}.`);
    console.log(`creditedOnce: ${!broken.some((b) => /transactions|ledger|said they/.test(b))}`);
    console.log(`balanceMatches: ${!broken.some((b) => b.startsWith('balance'))}`);
    if (broken.length) {
      console.error(`FAILED:\n${broken.join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log('PROVED: every deposit was credited exactly once, and the balance equals the deposits.');
    }
  } finally {
    const txs = await prisma.transaction.findMany({ where: { userId: user.id }, select: { id: true } });
    const txIds = txs.map((t) => t.id);
    await prisma.ledgerEntry.deleteMany({ where: { transactionId: { in: txIds } } });
    await prisma.nairaCollection.deleteMany({ where: { providerTransactionId: { in: ids } } });
    await prisma.transaction.deleteMany({ where: { id: { in: txIds } } });
    await prisma.balance.deleteMany({ where: { userId: user.id } });
    await prisma.virtualAccount.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } }).catch((e: Error) => console.error(`could not delete proof user ${user.id}: ${e.message}`));
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
