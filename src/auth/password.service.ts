import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HashSemaphore } from './hash-semaphore';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt, from node:crypto — memory-hard, native, and no build step, which
 * matters on a machine where npm install scripts are blocked.
 *
 * Stored as: scrypt$N$r$p$<salt-b64>$<hash-b64>. Parameters live in the hash,
 * so they can be raised later without invalidating existing passwords —
 * `needsRehash` tells you when a user's stored hash is behind current policy.
 *
 * argon2id is a valid upgrade if you later accept a native dependency.
 */
@Injectable()
export class PasswordService {
  private static readonly N = 2 ** 15; // ~32 MB per hash
  private static readonly R = 8;
  private static readonly P = 1;
  private static readonly KEYLEN = 64;
  private static readonly MAXMEM = 96 * 1024 * 1024;

  /** Bounds concurrent scrypt runs (spec §4.3). `new PasswordService()` gets the defaults. */
  private readonly gate: HashSemaphore;

  constructor(@Optional() config?: ConfigService) {
    this.gate = new HashSemaphore(
      Number(config?.get<number>('PASSWORD_HASH_CONCURRENCY') ?? 4),
      Number(config?.get<number>('PASSWORD_HASH_QUEUE') ?? 32),
    );
  }

  async hash(password: string): Promise<string> {
    return this.gate.run(() => this.hashNow(password));
  }

  /**
   * Constant-time. Returns false rather than throwing on a malformed hash, but a
   * full hash queue is a 503, never `false`: a busy server must not count as a
   * wrong password toward somebody's lockout.
   */
  async verify(password: string, stored: string): Promise<boolean> {
    return this.gate.run(() => this.verifyNow(password, stored));
  }

  private async hashNow(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await scryptAsync(password.normalize('NFKC'), salt, PasswordService.KEYLEN, {
      N: PasswordService.N,
      r: PasswordService.R,
      p: PasswordService.P,
      maxmem: PasswordService.MAXMEM,
    });
    return [
      'scrypt',
      PasswordService.N,
      PasswordService.R,
      PasswordService.P,
      salt.toString('base64'),
      derived.toString('base64'),
    ].join('$');
  }

  private async verifyNow(password: string, stored: string): Promise<boolean> {
    try {
      const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
      if (scheme !== 'scrypt') return false;

      const salt = Buffer.from(saltB64, 'base64');
      const expected = Buffer.from(hashB64, 'base64');
      const derived = await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
        N: Number(n),
        r: Number(r),
        p: Number(p),
        maxmem: PasswordService.MAXMEM,
      });
      return derived.length === expected.length && timingSafeEqual(derived, expected);
    } catch {
      return false;
    }
  }

  /** True when the stored hash used weaker parameters than we now require. */
  needsRehash(stored: string): boolean {
    const [scheme, n, r, p] = stored.split('$');
    return (
      scheme !== 'scrypt' ||
      Number(n) < PasswordService.N ||
      Number(r) < PasswordService.R ||
      Number(p) < PasswordService.P
    );
  }

  /**
   * Burn roughly the same time on a login for an address that does not exist.
   * Otherwise response timing tells an attacker which emails are registered.
   */
  async dummyVerify(): Promise<void> {
    await this.hash('timing-equalisation-only');
  }
}
