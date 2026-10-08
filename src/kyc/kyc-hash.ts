import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Marks a keyed hash. A stored hash without it is the legacy plain SHA-256. */
export const KYC_HASH_PREFIX = 'h1:';

/**
 * Development and test only. Env validation makes KYC_HASH_KEY mandatory in
 * staging and production, so this can never protect a real customer's number.
 */
export const DEV_KYC_HASH_KEY = 'davochain-development-kyc-hash-key-not-for-production';

/**
 * A BVN or NIN as stored: HMAC-SHA256 under a server key.
 *
 * A plain SHA-256 of an 11-digit number is reversible by brute force in
 * minutes (there are only 10^11 of them), so a leaked table would be a leaked
 * identity list. Keyed, it is useless without the key.
 */
export function hashIdentity(value: string, key: string): string {
  return KYC_HASH_PREFIX + createHmac('sha256', key).update(value.trim()).digest('hex');
}

/** The pre-A2 form: plain SHA-256 hex. Still read, never written. */
export function legacyHashIdentity(value: string): string {
  return createHash('sha256').update(value.trim()).digest('hex');
}

export function isLegacyHash(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.length > 0 && !stored.startsWith(KYC_HASH_PREFIX);
}

/** Does `value` hash to `stored`, in either form? Constant time. */
export function identityMatches(value: string, stored: string | null | undefined, key: string): boolean {
  if (!stored) return false;
  const candidate = isLegacyHash(stored) ? legacyHashIdentity(value) : hashIdentity(value, key);
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(stored, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

@Injectable()
export class KycHashService {
  private readonly log = new Logger(KycHashService.name);
  private readonly key: string;

  constructor(config: ConfigService) {
    const configured = config.get<string>('KYC_HASH_KEY');
    if (configured) {
      this.key = configured;
    } else {
      this.key = DEV_KYC_HASH_KEY;
      this.log.warn('KYC_HASH_KEY is not set: using the development key. Never run like this with real customers.');
    }
  }

  hash(value: string): string {
    return hashIdentity(value, this.key);
  }

  matches(value: string, stored: string | null | undefined): boolean {
    return identityMatches(value, stored, this.key);
  }

  isLegacy(stored: string | null | undefined): boolean {
    return isLegacyHash(stored);
  }
}
