#!/usr/bin/env node
/**
 * Credit a balance, for local testing only.
 *
 * Naira funding has no provider yet (see TODO.md), so nothing can put NGN into
 * a user's balance and buys cannot be exercised end to end. This stands in for
 * that until the provider is chosen.
 *
 *   npm run dev-credit -- --email ada@example.com --asset ngn --amount 500000
 *
 * It writes a proper double-entry pair (EXTERNAL debit / USER credit) rather
 * than poking `balances` directly — a balance that cannot be derived from
 * ledger_entries is exactly the thing the reconciliation invariant exists to
 * catch, and faking one here would make it fire.
 *
 * REFUSES to run when NODE_ENV=production.
 */
import { PrismaClient } from '@prisma/client';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
};

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('\n  Refusing to run in production. This mints balance out of nothing.\n');
    process.exit(1);
  }

  const email = arg('email');
  const asset = (arg('asset') ?? 'ngn').toLowerCase();
  const amount = arg('amount');

  if (!email || !amount) {
    console.error(
      '\n  Usage: npm run dev-credit -- --email you@example.com --asset ngn --amount 500000\n',
    );
    process.exit(1);
  }

  if (!/^\d+(\.\d+)?$/.test(amount)) {
    console.error('\n  Amount must be a positive number, as a string.\n');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) {
      console.error(`\n  No user with email ${email}\n`);
      process.exit(1);
    }

    await prisma.$transaction(async (tx) => {
      await tx.balance.upsert({
        where: { userId_assetCode: { userId: user.id, assetCode: asset } },
        create: { userId: user.id, assetCode: asset, available: amount, locked: '0' },
        update: { available: { increment: amount } },
      });

      // Double-entry, so the §4 invariant still holds afterwards.
      await tx.ledgerEntry.createMany({
        data: [
          {
            account: 'EXTERNAL',
            assetCode: asset,
            direction: 'DEBIT',
            amount,
            memo: 'dev-credit (local testing only)',
          },
          {
            account: 'USER',
            userId: user.id,
            assetCode: asset,
            direction: 'CREDIT',
            amount,
            memo: 'dev-credit (local testing only)',
          },
        ],
      });
    });

    const balance = await prisma.balance.findUnique({
      where: { userId_assetCode: { userId: user.id, assetCode: asset } },
    });

    console.log(
      `\n  Credited ${amount} ${asset.toUpperCase()} to ${email}` +
        `\n  New available balance: ${balance.available.toString()}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`\n  Failed: ${err.message}\n`);
  process.exit(1);
});
