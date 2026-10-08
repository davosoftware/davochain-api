import { Logger } from '@nestjs/common';
import {
  DEV_KYC_HASH_KEY,
  KycHashService,
  hashIdentity,
  identityMatches,
  isLegacyHash,
  legacyHashIdentity,
} from './kyc-hash';

const KEY = 'k'.repeat(32);
const BVN = '22222223883';
const H1 = 'h1:5d06137e3fbc7507a7ffddefa365578c223d66d9d9deaa0632b460854ca86883';
const LEGACY = '6e1ff87ee862e34d13e08ef97e2d756e2f6a055dd3981eafe04ef9c29fdc5a80';

describe('identity hashing', () => {
  it('hashes with HMAC-SHA256 under the key, prefixed h1:, ignoring surrounding spaces', () => {
    expect(hashIdentity(BVN, KEY)).toBe(H1);
    expect(hashIdentity(` ${BVN} `, KEY)).toBe(H1);
  });

  it('gives a different hash under a different key', () => {
    expect(hashIdentity(BVN, 'q'.repeat(32))).toBe(
      'h1:9f9c5f110e2d422af6cd8db0181e84e9946fd9c39f3745768d325b5a4daf47b3',
    );
  });

  it('still recognises the legacy plain SHA-256 form', () => {
    expect(legacyHashIdentity(BVN)).toBe(LEGACY);
    expect(isLegacyHash(LEGACY)).toBe(true);
    expect(isLegacyHash(H1)).toBe(false);
    expect(isLegacyHash(null)).toBe(false);
  });

  it('matches the right number in either form, and nothing else', () => {
    expect(identityMatches(BVN, H1, KEY)).toBe(true);
    expect(identityMatches(BVN, LEGACY, KEY)).toBe(true);
    expect(identityMatches('22222223884', H1, KEY)).toBe(false);
    expect(identityMatches('22222223884', LEGACY, KEY)).toBe(false);
    expect(identityMatches(BVN, H1, 'q'.repeat(32))).toBe(false);
    expect(identityMatches(BVN, null, KEY)).toBe(false);
    expect(identityMatches(BVN, 'h1:short', KEY)).toBe(false);
  });
});

describe('KycHashService', () => {
  it('uses KYC_HASH_KEY when it is set', () => {
    const svc = new KycHashService({ get: () => KEY } as never);
    expect(svc.hash(BVN)).toBe(H1);
    expect(svc.matches(BVN, H1)).toBe(true);
    expect(svc.isLegacy(LEGACY)).toBe(true);
  });

  it('falls back to the development key, loudly, when it is not set', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const svc = new KycHashService({ get: () => undefined } as never);
      expect(svc.hash(BVN)).toBe(hashIdentity(BVN, DEV_KYC_HASH_KEY));
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
