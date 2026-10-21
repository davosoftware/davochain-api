/**
 * Checks the five Advanced Dojah calls against the Dojah SANDBOX (spec 2026-10-21 §11).
 *
 * Spends sandbox calls only. Run only with the user's OK (plan Task 13).
 *
 * Run: CONFIRM_SANDBOX=yes npm run check:dojah-advanced
 *      (optional: -- --front a.jpg --back b.jpg --selfie s.jpg --bill bill.jpg)
 *
 * What it settles: the field names Dojah really uses (the ID reader's
 * text_data field_key list, and whether face match accepts selfie_image /
 * photoid_image). It prints, for each call, the HTTP status, the top-level keys
 * of the answer, and for the ID reader each field_key with its status. It never
 * prints a value, a name, a number, an image, a key or a link.
 *
 * The utility bill needs a link: it puts the bill under healthcheck/ in R2,
 * makes a 300-second link, calls Dojah, and deletes the file whatever happens.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DojahClient } from '../src/dojah/dojah.client';
import { DOJAH_SANDBOX_URL } from '../src/dojah/dojah.config';
import { mockImage } from '../src/dojah/dojah.mock';
import { R2FileStore, makeR2Client, r2Presigner } from '../src/storage/r2-file-store';
import type { DojahOp } from '../src/dojah/dojah.types';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const image = (name: string): Buffer => {
  const path = arg(name);
  return path ? readFileSync(path) : mockImage();
};
const keysOf = (v: unknown) => (v && typeof v === 'object' ? Object.keys(v as object).join(', ') : typeof v);

/** Keys only: never a value. */
function describe(op: DojahOp, body: unknown): void {
  const entity = (body as { entity?: Record<string, unknown> })?.entity;
  console.log(`  answer keys: ${keysOf(body)}; entity keys: ${keysOf(entity)}`);
  if (op === 'readId' && entity) {
    const td = Array.isArray(entity.text_data) ? (entity.text_data as Array<{ field_key?: unknown; status?: unknown }>) : [];
    console.log(`  text_data field_key (status): ${td.map((f) => `${String(f.field_key)} (${String(f.status)})`).join(', ') || 'none'}`);
    console.log(`  status keys: ${keysOf(entity.status)}; document_images keys: ${keysOf(entity.document_images)}`);
  }
  if (op === 'faceMatch' && entity) console.log(`  selfie keys: ${keysOf(entity.selfie)}`);
  if (op === 'liveness' && entity) console.log(`  liveness keys: ${keysOf(entity.liveness)}; face keys: ${keysOf(entity.face)}`);
}

async function main(): Promise<number> {
  const base = (process.env.DOJAH_BASE_URL ?? DOJAH_SANDBOX_URL).replace(/\/+$/, '');
  if (base !== DOJAH_SANDBOX_URL) {
    console.error(`Refusing: DOJAH_BASE_URL must be the sandbox (${DOJAH_SANDBOX_URL}).`);
    return 2;
  }
  if (process.env.CONFIRM_SANDBOX !== 'yes') {
    console.error('Refusing: set CONFIRM_SANDBOX=yes to spend sandbox calls (plan Task 13: run only with the OK).');
    return 2;
  }
  const appId = process.env.DOJAH_APP_ID;
  const secretKey = process.env.DOJAH_SECRET_KEY;
  if (!appId || !secretKey) {
    console.error('Missing in .env: DOJAH_APP_ID and/or DOJAH_SECRET_KEY');
    return 2;
  }
  const client = new DojahClient({ baseUrl: base, credentials: async () => ({ appId, secretKey }) }, undefined, describe);
  const b64 = (b: Buffer) => b.toString('base64');
  let failed = 0;
  const step = async (name: string, fn: () => Promise<unknown>) => {
    console.log(`\n${name}`);
    try {
      await fn();
      console.log('  ✓ answered');
    } catch (err) {
      failed++;
      const e = err as { kind?: string; httpStatus?: number; message?: string };
      console.log(`  ✗ ${e.kind ?? 'error'} (HTTP ${e.httpStatus ?? '?'}): ${e.message ?? ''}`);
    }
  };

  let portrait: string | null = null;
  await step('Read ID (document analysis)', async () => {
    const r = await client.readId({ idType: 'NATIONAL_ID', front: b64(image('front')), back: b64(image('back')) });
    portrait = r.portrait;
    console.log(`  portrait returned: ${portrait ? 'yes' : 'no'}`);
  });
  await step('Liveness', () => client.liveness(b64(image('selfie'))));
  await step('Face match (selfie_image + photoid_image)', () => client.faceMatch(b64(image('selfie')), portrait ?? b64(image('front'))));
  await step('Text reader (OCR)', () => client.ocr(b64(image('bill'))));

  const r2 = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].every((n) => process.env[n]);
  if (!r2) {
    console.log('\nUtility bill: skipped (no R2 settings in .env)');
  } else {
    const bucket = process.env.R2_BUCKET!;
    const s3 = makeR2Client({ accountId: process.env.R2_ACCOUNT_ID!, accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!, bucket });
    const store = new R2FileStore(s3, bucket, r2Presigner(s3, bucket));
    const key = `healthcheck/dojah-bill-${randomUUID()}`;
    try {
      await store.put(key, image('bill'), 'image/jpeg');
      const link = await store.temporaryLink(key, 300);
      await step('Utility bill (via a 300-second link)', () => client.utilityBill(link));
    } finally {
      await store.delete(key);
      console.log(`  test file removed from R2`);
    }
  }
  console.log(failed ? `\n${failed} call(s) failed.` : '\nAll calls answered.');
  return failed ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
