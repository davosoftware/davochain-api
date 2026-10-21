import { createHmac } from 'node:crypto';
import { payrepSignature, verifyPayrepWebhook } from './webhook-signature';

const secret = 'a'.repeat(64);
const raw = Buffer.from('{"event":"deposit.success","data":{"transaction_id":"t1"}}');
const now = 1_790_000_000_000;
const ts = String(now / 1000);

describe('Payrep webhook signature (spec §2.5 C1)', () => {
  it('matches the documented recipe exactly: hex HMAC-SHA256 of "{ts}:{body}"', () => {
    const expected = createHmac('sha256', secret).update(`${ts}:${raw.toString()}`).digest('hex');
    expect(payrepSignature(secret, ts, raw)).toBe(expected);
  });
  it('OK with the right signature and a fresh time', () =>
    expect(verifyPayrepWebhook({ secret, timestamp: ts, signature: payrepSignature(secret, ts, raw), raw, nowMs: now })).toBe('OK'));
  it('refuses a body-only or sha256= signature (no fallback recipe)', () => {
    const bodyOnly = createHmac('sha256', secret).update(raw).digest('hex');
    expect(verifyPayrepWebhook({ secret, timestamp: ts, signature: bodyOnly, raw, nowMs: now })).toBe('BAD_SIGNATURE');
    expect(verifyPayrepWebhook({ secret, timestamp: ts, signature: `sha256=${payrepSignature(secret, ts, raw)}`, raw, nowMs: now })).toBe('BAD_SIGNATURE');
  });
  it('a valid signature older or newer than 5 minutes is STALE (Review Focus 3)', () => {
    const old = String(now / 1000 - 301);
    expect(verifyPayrepWebhook({ secret, timestamp: old, signature: payrepSignature(secret, old, raw), raw, nowMs: now })).toBe('STALE');
    const future = String(now / 1000 + 301);
    expect(verifyPayrepWebhook({ secret, timestamp: future, signature: payrepSignature(secret, future, raw), raw, nowMs: now })).toBe('STALE');
    const edge = String(now / 1000 - 299);
    expect(verifyPayrepWebhook({ secret, timestamp: edge, signature: payrepSignature(secret, edge, raw), raw, nowMs: now })).toBe('OK');
  });
  it('missing headers or no secret', () => {
    expect(verifyPayrepWebhook({ secret, raw, nowMs: now })).toBe('MISSING');
    expect(verifyPayrepWebhook({ secret: null, timestamp: ts, signature: 'x', raw, nowMs: now })).toBe('NO_SECRET');
    expect(verifyPayrepWebhook({ secret, timestamp: 'abc', signature: 'x', raw, nowMs: now })).toBe('MISSING');
  });
  it('a changed body breaks the signature', () => {
    const changed = Buffer.from(raw.toString().replace('t1', 't2'));
    expect(verifyPayrepWebhook({ secret, timestamp: ts, signature: payrepSignature(secret, ts, raw), raw: changed, nowMs: now })).toBe('BAD_SIGNATURE');
  });
  it('an upper-case hex signature is accepted', () =>
    expect(verifyPayrepWebhook({ secret, timestamp: ts, signature: payrepSignature(secret, ts, raw).toUpperCase(), raw, nowMs: now })).toBe('OK'));
});
