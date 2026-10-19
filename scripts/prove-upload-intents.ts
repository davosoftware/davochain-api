/**
 * Proves, on real Postgres, that the upload sweeper and a request saving its
 * record can never both "win" (R2 storage spec §6): for an intent old enough
 * to sweep, a claim (the record's transaction) and a sweep run at the same
 * moment. Every round must end in exactly one of:
 *   - claimed: the file is still there (a saved record points at it), or
 *   - swept:   the claim was refused and the file is gone.
 * Never a saved record pointing at a deleted file.
 *
 * Uses the in-memory file store; touches only pending_uploads rows it creates
 * under proof/. Local development database only.
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"CommonJS"}' scripts/prove-upload-intents.ts
 */
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { MemoryFileStore } from '../src/storage/memory-file-store';
import { UploadIntents, INTENT_MAX_AGE_MS } from '../src/storage/upload-intents.service';
import { refuseUnlessLocalDevelopment } from './local-dev-guard';

const ROUNDS = 40;

async function main(): Promise<void> {
  refuseUnlessLocalDevelopment();
  const prisma = new PrismaService();
  await prisma.$connect();
  const store = new MemoryFileStore();
  const intents = new UploadIntents(prisma, store);
  let claimed = 0;
  let swept = 0;
  const broken: string[] = [];
  try {
    for (let i = 0; i < ROUNDS; i++) {
      const key = `proof/${randomUUID()}`;
      await store.put(key, Buffer.from('x'), 'image/png');
      await prisma.pendingUpload.create({ data: { key, createdAt: new Date(Date.now() - INTENT_MAX_AGE_MS - 60_000) } });
      const [claim] = await Promise.allSettled([
        prisma.$transaction((tx) => intents.claim(tx, [key])),
        intents.sweep(),
      ]);
      const fileThere = store.has(key);
      if (claim.status === 'fulfilled') {
        claimed++;
        if (!fileThere) broken.push(`${key}: claimed but its file was deleted`);
      } else {
        swept++;
        if (fileThere) broken.push(`${key}: refused but its file was left behind`);
      }
    }
    const left = await prisma.pendingUpload.count({ where: { key: { startsWith: 'proof/' } } });
    console.log(`Rounds: ${ROUNDS} · claim won: ${claimed} · sweep won: ${swept} · intents left: ${left}`);
    if (broken.length > 0 || left !== 0) {
      console.error(`FAILED:\n${broken.join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log('PROVED: every round ended with exactly one owner; no saved record ever lost its file.');
    }
  } finally {
    await prisma.pendingUpload.deleteMany({ where: { key: { startsWith: 'proof/' } } });
    await prisma.$disconnect();
  }
}

void main();
