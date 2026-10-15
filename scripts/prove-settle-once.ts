/**
 * Proves a swap is closed exactly once on real Postgres (PROJECT_REVIEW H6):
 * several "complete it" calls (webhook, re-delivery, reconciler) and several
 * "refund it" calls race for the same in-flight swap. Exactly one may win, and
 * the balances must show one outcome only: either swapped, or refunded.
 *
 * The user also has OTHER funds locked in the same coin (another withdrawal in
 * flight). That is the dangerous case: without the fix, a second settle can
 * pass the ledger's own "enough locked?" check by eating those funds.
 *
 * Quidax is not called. It writes real (tiny) ledger rows, so it refuses to run
 * unless NODE_ENV is development and the database is on this machine.
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"CommonJS"}' scripts/prove-settle-once.ts <user email> [racers]
 */
import { randomUUID } from 'node:crypto';
import { LedgerAccount, TxStatus, TxType } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { SettlementService } from '../src/trades/settlement.service';
import { refuseUnlessLocalDevelopment } from './local-dev-guard';

async function main(): Promise<void> {
  refuseUnlessLocalDevelopment();
  const email = process.argv[2];
  const racers = Number(process.argv[3] ?? 8);
  if (!email) throw new Error('Usage: prove-settle-once.ts <user email> [racers]');

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const ledger = new LedgerService(prisma);
    const settlement = new SettlementService(
      prisma, {} as never, ledger,
      { notify: async () => undefined } as never, {} as never,
      { evaluate: async () => undefined } as never,
    );
    const [from, to] = ['btc', 'usdt'];
    const amountIn = '0.0001';
    const amountOut = '6';

    // Fund the run (local test user only): enough for the swap plus the other in-flight funds.
    await prisma.serializable(async (t) => {
      const fund = await t.transaction.create({
        data: { userId: user.id, type: TxType.DEPOSIT, status: TxStatus.COMPLETED, reference: `prove-h6-fund-${randomUUID()}`, toAsset: from, toAmount: '0.0003' },
      });
      await ledger.credit(t, { userId: user.id, assetCode: from, amount: '0.0003', counterparty: LedgerAccount.EXTERNAL, transactionId: fund.id, memo: 'proof funding (local test user)' });
    });
    const otherLocked = '0.0002';
    await prisma.serializable((t) => ledger.lock(t, user.id, from, otherLocked));
    const btc0 = await ledger.getBalance(user.id, from);
    const usdt0 = await ledger.getBalance(user.id, to);
    const tx = await prisma.serializable(async (t) => {
      await ledger.lock(t, user.id, from, amountIn);
      return t.transaction.create({
        data: {
          userId: user.id, type: TxType.SWAP, status: TxStatus.PROCESSING, reference: `prove-h6-${randomUUID()}`,
          fromAsset: from, fromAmount: amountIn, toAsset: to, toAmount: amountOut,
        },
      });
    });

    const results = await Promise.allSettled(
      Array.from({ length: racers }, (_, i) => (i % 2 === 0 ? settlement.finaliseSwap(tx.id) : settlement.reverse(tx.id, 'proof refund'))),
    );

    const final = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    const btc1 = await ledger.getBalance(user.id, from);
    const usdt1 = await ledger.getBalance(user.id, to);
    const btcDelta = btc1.available.minus(btc0.available);
    const usdtDelta = usdt1.available.minus(usdt0.available);
    const lockedBack = btc1.locked.eq(btc0.locked);

    const swappedOnce = final.status === 'COMPLETED' && btcDelta.eq(`-${amountIn}`) && usdtDelta.eq(amountOut);
    const refundedOnce = final.status === 'FAILED' && btcDelta.isZero() && usdtDelta.isZero();
    const proven = lockedBack && (swappedOnce || refundedOnce);
    // Put the other in-flight funds back, whatever is left of them.
    const leftLocked = btc1.locked;
    if (leftLocked.gt(0)) await prisma.serializable((t) => ledger.unlock(t, user.id, from, leftLocked.lt(otherLocked) ? leftLocked : otherLocked));
    if (!proven) process.exitCode = 1;
    console.log(JSON.stringify({
      racers,
      outcome: final.status,
      exactlyOneOutcome: swappedOnce || refundedOnce,
      otherLockedFundsUntouched: lockedBack,
      btcAvailableDelta: btcDelta.toFixed(),
      usdtAvailableDelta: usdtDelta.toFixed(),
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
