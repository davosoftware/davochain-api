/**
 * Proves DepositsService credits a Quidax deposit exactly once on real
 * Postgres (PROJECT_REVIEW C2): the deposit is first seen as pending, then
 * several "accepted" deliveries race for it, the way Quidax re-sends, the gap
 * sweep and parallel workers do in production.
 *
 * Quidax is not called. It writes a real (tiny) ledger credit, so it refuses
 * to run unless NODE_ENV is development and the database is on this machine.
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"CommonJS"}' scripts/prove-deposit-credit-once.ts <user email> [racers]
 */
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { KycLimitsService } from '../src/kyc/kyc-limits.service';
import { LevelPolicyService } from '../src/levels/level-policy.service';
import { DepositsService } from '../src/deposits/deposits.service';
import { refuseUnlessLocalDevelopment } from './local-dev-guard';

async function main(): Promise<void> {
  refuseUnlessLocalDevelopment();
  const email = process.argv[2];
  const racers = Number(process.argv[3] ?? 8);
  if (!email) throw new Error('Usage: prove-deposit-credit-once.ts <user email> [racers]');

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const ledger = new LedgerService(prisma);
    const deposits = new DepositsService(
      prisma,
      ledger,
      { findUserByQuidax: async () => user.id } as never,
      { notify: async () => undefined } as never,
      { price: async () => ({ priceUsd: '60000', ngnPerUsd: '1500' }) } as never,
      new KycLimitsService(prisma, new LevelPolicyService(prisma, { price: async () => ({ ngnPerUsd: '1500' }) } as never)),
    );

    const id = `prove-c2-${randomUUID()}`;
    const deposit = (status: string) =>
      ({ id, type: 'coin_address', currency: 'btc', amount: '0.0001', fee: '0', txid: `0x${id}`, status, reason: null, user: { id: 'qx', sn: 'QDX' } }) as never;

    const before = await ledger.getBalance(user.id, 'btc');
    await deposits.applyWebhook('deposit.transaction.confirmation', deposit('submitted'));
    const results = await Promise.allSettled(
      Array.from({ length: racers }, (_, i) =>
        i % 2 === 0 ? deposits.applyWebhook('deposit.successful', deposit('accepted')) : deposits.sweepGaps([deposit('accepted')]),
      ),
    );
    const after = await ledger.getBalance(user.id, 'btc');
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { reference: `quidax_deposit_${id}` } });
    const entries = await prisma.ledgerEntry.count({ where: { transactionId: tx.id } });
    const delta = after.available.minus(before.available);

    const proven = delta.eq('0.0001') && tx.status === 'COMPLETED' && entries > 0;
    if (!proven) process.exitCode = 1;
    console.log(JSON.stringify({
      racers,
      balanceUpByExactlyOneDeposit: delta.eq('0.0001'),
      balanceDelta: delta.toFixed(),
      status: tx.status,
      ledgerEntries: entries,
      errors: results.filter((r) => r.status === 'rejected').map((r) => ((r as PromiseRejectedResult).reason as Error).message),
    }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
