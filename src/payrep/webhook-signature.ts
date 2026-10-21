import { createHmac, timingSafeEqual } from 'node:crypto';

/** Spec §2.5 C1 (the user's decision): hex HMAC-SHA256(secret, "{X-Timestamp}:{raw body}"). One recipe, no fallback. */
export function payrepSignature(secret: string, timestamp: string, raw: Buffer | string): string {
  return createHmac('sha256', secret).update(`${timestamp}:`).update(raw).digest('hex');
}

/** A signed delivery older (or newer) than this is a replay. */
export const MAX_SKEW_MS = 5 * 60_000;

export type WebhookVerdict = 'OK' | 'NO_SECRET' | 'MISSING' | 'BAD_SIGNATURE' | 'STALE';

export function verifyPayrepWebhook(i: { secret: string | null; timestamp?: string; signature?: string; raw: Buffer; nowMs: number }): WebhookVerdict {
  if (!i.secret) return 'NO_SECRET';
  if (!i.timestamp || !/^\d{1,12}$/.test(i.timestamp) || !i.signature) return 'MISSING';
  const expected = Buffer.from(payrepSignature(i.secret, i.timestamp, i.raw), 'utf8');
  // Hex is case-insensitive; anything else (a "sha256=" prefix, base64) simply fails to match.
  const given = Buffer.from(i.signature.trim().toLowerCase(), 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'BAD_SIGNATURE';
  if (Math.abs(i.nowMs - Number(i.timestamp) * 1000) > MAX_SKEW_MS) return 'STALE';
  return 'OK';
}
