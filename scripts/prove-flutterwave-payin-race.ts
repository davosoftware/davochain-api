/**
 * Proves PayInService credits a payment exactly once when several processors
 * race for it on real Postgres: a webhook, the sweep and the re-check pass
 * arriving at the same moment (plan A1, review focus 2).
 *
 * Needs a Tier 1 user with a Flutterwave virtual account and a non-zero Tier 1
 * deposit limit. Flutterwave is the in-memory mock; nothing leaves the machine.
 *
 * It writes a real ledger credit, so it refuses to run unless NODE_ENV is
 * development and the database is on this machine.
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"CommonJS"}' scripts/prove-flutterwave-payin-race.ts <user email> [racers]
 */
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { KycLimitsService } from '../src/kyc/kyc-limits.service';
import { FlutterwaveMockClient } from '../src/flutterwave/flutterwave.mock';
import { VirtualAccountsService } from '../src/ngn-deposits/virtual-accounts.service';
import { PayInService } from '../src/ngn-deposits/pay-in.service';
import { txRefForUser } from '../src/ngn-deposits/tx-ref';
import { refuseUnlessLocalDevelopment } from './local-dev-guard';

async function main(): Promise<void> {
  refuseUnlessLocalDevelopment();
  const email = process.argv[2];
  const racers = Number(process.argv[3] ?? 5);
  if (!email) throw new Error('Usage: prove-flutterwave-payin-race.ts <user email> [racers]');

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const account = await prisma.virtualAccount.findFirst({ where: { userId: user.id, isPrimary: true } });
    if (!account) throw new Error(`${email} has no virtual account`);

    const ledger = new LedgerService(prisma);
    const client = new FlutterwaveMockClient({
      rateLimitPerMinute: 100_000, port: 1, secretKey: async () => 'FLWSECK_TEST-race-X', secretHash: async () => null,
    } as never);
    const quiet = { raise: async () => true };
    const accounts = new VirtualAccountsService(prisma, client, {} as never, {} as never, quiet as never);
    const payIn = new PayInService(
      prisma, client, accounts, ledger, new KycLimitsService(prisma),
      { notify: async () => undefined } as never,
      { price: async () => { throw new Error('no price needed for a proof'); } } as never,
      quiet as never,
      { add: async () => undefined } as never,
    );

    const before = await ledger.getBalance(user.id, 'ngn');
    const { id } = await client.simulatePayIn({
      txRef: txRefForUser(user.id), amount: '1000', accountNumber: account.accountNumber,
      payerName: `${user.firstName} ${user.lastName}`.toUpperCase(), sendWebhook: false,
    });
    await prisma.flutterwaveCollection.create({ data: { flwTransactionId: id, outcome: 'UNVERIFIED', firstSource: 'WEBHOOK' } });

    const results = await Promise.allSettled(
      Array.from({ length: racers }, (_, i) => payIn.processPayment(id, i === 0 ? 'WEBHOOK' : 'SWEEP')),
    );
    const after = await ledger.getBalance(user.id, 'ngn');
    const txs = await prisma.transaction.findMany({ where: { reference: `flw:payin:${id}` } });
    const entries = txs.length === 1 ? await prisma.ledgerEntry.count({ where: { transactionId: txs[0].id } }) : -1;
    const credited = results.filter((r) => r.status === 'fulfilled' && r.value.changed && r.value.outcome === 'CREDITED').length;

    const proven = credited === 1 && txs.length === 1 && entries === 3 && after.available.minus(before.available).eq(1000);
    if (!proven) process.exitCode = 1;
    console.log(JSON.stringify({
      racers,
      creditedOnce: credited === 1,
      oneTransaction: txs.length === 1,
      threeEntries: entries === 3,
      balanceUpByExactly1000: after.available.minus(before.available).eq(1000),
      outcomes: results.map((r) =>
        r.status === 'fulfilled' ? `${r.value.outcome}${r.value.changed ? ' (this run)' : ''}` : `error: ${(r.reason as Error).message}`,
      ),
    }));
  } finally {
    await prisma.$disconnect();
  }
}

void main();
