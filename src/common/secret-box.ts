import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM, for values that are money if somebody reads them.
 *
 * Extracted from CredentialsService so a gift card voucher code gets exactly
 * the treatment a partner API key does. Both are bearer instruments: whoever
 * holds the string can spend it, and a database backup or a leaked query
 * result should not hand either one over.
 *
 * GCM rather than CBC because it authenticates as well as encrypts — a
 * tampered row fails to open instead of decrypting to something plausible.
 * The IV is fresh per value and stored beside the ciphertext, which is what
 * makes encrypting the same code twice produce two different rows.
 */
export class SecretBox {
  private readonly key: Buffer | null;

  constructor(passphrase: string | undefined) {
    // Any length in, 32 bytes out. A passphrase is what people actually paste,
    // and refusing one only leads to a weaker key written down somewhere else.
    this.key = passphrase ? createHash('sha256').update(passphrase).digest() : null;
  }

  get isConfigured(): boolean {
    return this.key !== null;
  }

  /** iv:tag:ciphertext, all base64. Throws if there is no key. */
  seal(plaintext: string): string {
    if (!this.key) {
      throw new Error('No encryption key is configured');
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      enc.toString('base64'),
    ].join(':');
  }

  /**
   * The plaintext, or null if it cannot be trusted.
   *
   * Never throws. A wrong key or a tampered row is a value we must not use,
   * and the caller's job is to say "this code could not be read" rather than
   * to crash a screen full of other people's trades.
   */
  open(stored: string | null): string | null {
    if (!this.key || !stored) return null;
    const [iv, tag, data] = stored.split(':');
    if (!iv || !tag || !data) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }
}
