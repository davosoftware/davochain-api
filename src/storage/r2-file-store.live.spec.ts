import { randomUUID } from 'node:crypto';
import { R2FileStore, makeR2Client } from './r2-file-store';

/**
 * The one test that talks to the REAL Cloudflare R2 bucket.
 *
 * Skipped unless R2_LIVE_TEST=1 and the four R2_* settings are present, so a
 * normal `npm test` never touches it. It writes one tiny object under
 * healthcheck/, reads it back, deletes it, and checks it is gone.
 *
 *   R2_LIVE_TEST=1 npx jest src/storage/r2-file-store.live.spec.ts
 */
const env = process.env;
const ready =
  env.R2_LIVE_TEST === '1' && !!env.R2_ACCOUNT_ID && !!env.R2_ACCESS_KEY_ID && !!env.R2_SECRET_ACCESS_KEY && !!env.R2_BUCKET;

(ready ? describe : describe.skip)('R2FileStore against the real bucket (R2_LIVE_TEST=1)', () => {
  const store = () =>
    new R2FileStore(
      makeR2Client({
        accountId: env.R2_ACCOUNT_ID!,
        accessKeyId: env.R2_ACCESS_KEY_ID!,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
        bucket: env.R2_BUCKET!,
      }),
      env.R2_BUCKET!,
    );

  it('reaches the bucket, round-trips one object, and removes it', async () => {
    const s = store();
    expect(await s.ping()).toBe(true);
    const key = `healthcheck/${randomUUID()}`;
    await s.put(key, Buffer.from('davochain r2 check'), 'text/plain');
    try {
      const got = await s.get(key);
      expect(got?.bytes.toString()).toBe('davochain r2 check');
      expect(got?.contentType).toBe('text/plain');
    } finally {
      await s.delete(key);
    }
    expect(await s.get(key)).toBeNull();
  }, 60_000);
});
