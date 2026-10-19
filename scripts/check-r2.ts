/**
 * Checks the real Cloudflare R2 bucket with the keys in .env (H8).
 *
 * Run: npm run check:r2
 *
 * It writes ONE tiny object under healthcheck/, reads it back, deletes it, and
 * checks it is gone. It also checks the bucket refuses anonymous reads (it
 * must be private). Secrets are never printed: only the bucket name and the
 * result of each step.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { R2FileStore, makeR2Client } from '../src/storage/r2-file-store';

const NAMES = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const;

async function main(): Promise<number> {
  const missing = NAMES.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    console.error(`Missing in .env: ${missing.join(', ')}`);
    return 2;
  }
  const bucket = process.env.R2_BUCKET!;
  const accountId = process.env.R2_ACCOUNT_ID!;
  const store = new R2FileStore(
    makeR2Client({
      accountId,
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      bucket,
    }),
    bucket,
  );
  const step = (ok: boolean, text: string) => console.log(`${ok ? '✓' : '✗'} ${text}`);

  console.log(`Checking R2 bucket "${bucket}"\n`);
  const reachable = await store.ping();
  step(reachable, 'The bucket answers with these keys');
  if (!reachable) return 1;

  const key = `healthcheck/${randomUUID()}`;
  const text = `davochain r2 check ${new Date().toISOString()}`;
  try {
    await store.put(key, Buffer.from(text), 'text/plain');
    step(true, 'Saved a test file');
    const got = await store.get(key);
    const same = got?.bytes.toString() === text;
    step(same, 'Read it back unchanged');

    // A private bucket refuses a request with no keys at all.
    const anon = await fetch(`https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`).catch(() => null);
    const isPrivate = !anon || anon.status === 400 || anon.status === 401 || anon.status === 403;
    step(isPrivate, isPrivate ? 'Anonymous reads are refused (the bucket is private)' : `Anonymous read returned ${anon?.status}: make the bucket private`);

    await store.delete(key);
    const gone = (await store.get(key)) === null;
    step(gone, 'Deleted the test file');
    return same && isPrivate && gone ? 0 : 1;
  } catch (err) {
    step(false, `Failed: ${(err as Error).message}`);
    await store.delete(key).catch(() => undefined);
    return 1;
  }
}

main().then((code) => process.exit(code));
