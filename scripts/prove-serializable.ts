/**
 * Proves the retry loop in PrismaService.serializable() against real Postgres.
 *
 * Read-then-write on one row under serializable isolation is the exact shape
 * every money path has: read the balance, decide, write it back. Run enough of
 * them at once and Postgres refuses some — which is the behaviour we want, and
 * the behaviour that used to reach the caller as a 500.
 *
 * Run: npx ts-node --compiler-options {"module":"CommonJS"} scripts/prove-serializable.ts
 */
import { PrismaService } from '../src/prisma/prisma.service';

const CONCURRENCY = Number(process.argv[2] ?? 12);

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.$connect();

  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS _serializable_probe');
  await prisma.$executeRawUnsafe(
    'CREATE TABLE _serializable_probe (id text PRIMARY KEY, n integer NOT NULL)',
  );
  await prisma.$executeRawUnsafe("INSERT INTO _serializable_probe VALUES ('x', 0)");

  // Every one of these reads the same row and writes it back. Without a retry
  // most of them lose and throw.
  const bump = () =>
    prisma.serializable(async (t) => {
      const [row] = await t.$queryRawUnsafe<{ n: number }[]>(
        "SELECT n FROM _serializable_probe WHERE id = 'x'",
      );
      await t.$executeRawUnsafe(
        `UPDATE _serializable_probe SET n = ${row.n + 1} WHERE id = 'x'`,
      );
      return row.n + 1;
    });

  const settled = await Promise.allSettled(Array.from({ length: CONCURRENCY }, bump));

  const ok = settled.filter((r) => r.status === 'fulfilled').length;
  const conflicts = settled.filter(
    (r) => r.status === 'rejected' && r.reason?.status === 409,
  ).length;
  const other = settled.filter(
    (r) => r.status === 'rejected' && r.reason?.status !== 409,
  ).length;

  const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(
    "SELECT n FROM _serializable_probe WHERE id = 'x'",
  );

  console.log(`\n${CONCURRENCY} concurrent read-then-write transactions on one row\n`);
  console.log(`  succeeded            ${ok}`);
  console.log(`  clean 409 conflicts  ${conflicts}`);
  console.log(`  500s / other errors  ${other}`);
  console.log(`  final counter        ${n}   (expected ${ok})`);

  for (const r of settled) {
    if (r.status === 'rejected' && r.reason?.status !== 409) {
      console.log(`\n  unexpected: ${r.reason?.constructor?.name} ${r.reason?.message}`);
    }
  }

  await prisma.$executeRawUnsafe('DROP TABLE _serializable_probe');
  await prisma.$disconnect();

  const clean = other === 0 && n === ok;
  console.log(
    `\n${clean ? 'PASS' : 'FAIL'} — no unhandled failures, and the counter matches the winners.\n`,
  );
  process.exit(clean ? 0 : 1);
}

void main();
