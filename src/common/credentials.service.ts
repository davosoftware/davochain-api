import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The partner secrets an admin may set, and where each one came from before.
 *
 * `env` is the variable that still works when nothing is stored — every install
 * boots from the environment, and the database only takes over once somebody
 * saves a value. Without that fallback, storing the Quidax key would require an
 * app that already had the Quidax key.
 */
export const CREDENTIALS = [
  {
    group: 'Quidax',
    name: 'quidax.secretKey',
    label: 'Secret key',
    env: 'QUIDAX_SECRET_KEY',
    hint: 'Authorises every call that moves money. Rotating it here takes effect on the next request.',
  },
  {
    group: 'Quidax',
    name: 'quidax.webhookSecret',
    label: 'Webhook secret',
    env: 'QUIDAX_WEBHOOK_SECRET',
    hint: 'Signs the events Quidax sends us. Wrong value means every webhook is rejected.',
  },
  {
    group: 'Email',
    name: 'smtp.password',
    label: 'SMTP password',
    env: 'SMTP_PASSWORD',
    hint: 'Sends admin alerts and password-reset codes.',
  },
  {
    group: 'Push',
    name: 'fcm.privateKey',
    label: 'Firebase private key',
    env: 'FCM_PRIVATE_KEY',
    hint: 'The PEM from the service account JSON. Paste it whole, newlines and all.',
  },
] as const;

export type CredentialName = (typeof CREDENTIALS)[number]['name'];

const BY_NAME = new Map(CREDENTIALS.map((c) => [c.name, c]));

/**
 * Partner secrets, held by the platform instead of the deployment.
 *
 * The value is encrypted with AES-256-GCM under a key that lives in the
 * environment and never in this table. A stolen database dump is therefore
 * ciphertext rather than a Quidax key that can move money — which is the entire
 * reason this is safe to do at all. Storing them in plain columns would turn
 * every backup into a set of live credentials.
 *
 * Nothing here ever returns a secret to a client. The admin screen sees the
 * last four characters and when it changed, which is enough to tell which key
 * is loaded and useless to anybody who steals the screenshot.
 */
@Injectable()
export class CredentialsService implements OnModuleInit {
  private readonly log = new Logger(CredentialsService.name);
  private key: Buffer | null = null;

  /**
   * Decrypted values, held in memory.
   *
   * Every Quidax call would otherwise be a database read and a decrypt. The
   * cache is invalidated on write, and the process is the only thing that can
   * see it.
   */
  private cache = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const raw = this.config.get<string>('CREDENTIALS_KEY');
    if (!raw) {
      this.log.warn(
        'CREDENTIALS_KEY is not set — partner secrets cannot be stored or read from the ' +
          'database. The environment variables are still used. See docs/CREDENTIALS.md.',
      );
      return;
    }
    // Any length in, 32 bytes out. A passphrase is what people actually paste,
    // and refusing one only leads to a weaker key written down somewhere else.
    this.key = createHash('sha256').update(raw).digest();
  }

  get isConfigured(): boolean {
    return this.key !== null;
  }

  private encrypt(plaintext: string): string {
    if (!this.key) {
      throw new BadRequestException(
        'CREDENTIALS_KEY is not set on the API, so secrets cannot be stored. ' +
          'Set it and restart before saving a key here.',
      );
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(
      ':',
    );
  }

  private decrypt(stored: string): string | null {
    if (!this.key) return null;
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
      // Wrong key, or a tampered row. Either way this value cannot be trusted,
      // and falling back to the environment beats sending Quidax a bad token.
      this.log.error('A stored credential could not be decrypted — is CREDENTIALS_KEY correct?');
      return null;
    }
  }

  /**
   * The value in force: the stored one if there is one, otherwise the
   * environment. Callers never need to know which.
   */
  async get(name: CredentialName): Promise<string | undefined> {
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;

    const definition = BY_NAME.get(name);
    const fromEnv = definition ? this.config.get<string>(definition.env) : undefined;

    if (!this.key) return fromEnv;

    const row = await this.prisma.integrationCredential.findUnique({ where: { name } });
    const stored = row ? this.decrypt(row.ciphertext) : null;
    const value = stored ?? fromEnv;

    if (value !== undefined) this.cache.set(name, value);
    return value;
  }

  /** What the admin screen shows: which keys are set, and never their values. */
  async list() {
    const rows = await this.prisma.integrationCredential.findMany();
    const byName = new Map(rows.map((r) => [r.name, r]));

    return {
      /** Without this, a saved key would be stored but unreadable. */
      encryptionConfigured: this.isConfigured,
      credentials: CREDENTIALS.map((c) => {
        const row = byName.get(c.name);
        const fromEnv = this.config.get<string>(c.env);
        return {
          name: c.name,
          group: c.group,
          label: c.label,
          hint: c.hint,
          envVar: c.env,
          source: row ? 'database' : fromEnv ? 'environment' : 'unset',
          last4: row?.last4 ?? (fromEnv ? fromEnv.slice(-4) : null),
          updatedAt: row?.updatedAt ?? null,
          updatedBy: row?.updatedBy ?? null,
        };
      }),
    };
  }

  async set(name: string, value: string, updatedBy: string) {
    const definition = BY_NAME.get(name as CredentialName);
    if (!definition) throw new BadRequestException('That is not a credential this system uses');

    const trimmed = value.trim();
    if (!trimmed) throw new BadRequestException('Paste the key, or use Clear to remove it');

    await this.prisma.integrationCredential.upsert({
      where: { name },
      create: {
        name,
        ciphertext: this.encrypt(trimmed),
        last4: trimmed.slice(-4),
        updatedBy,
      },
      update: {
        ciphertext: this.encrypt(trimmed),
        last4: trimmed.slice(-4),
        updatedBy,
      },
    });

    this.cache.delete(name);
    // The name, never the value. A log is the last place a secret should land.
    this.log.warn(`Credential ${name} replaced by ${updatedBy}`);
    return this.list();
  }

  /** Removes the stored value; the environment variable takes over again. */
  async clear(name: string, updatedBy: string) {
    await this.prisma.integrationCredential.deleteMany({ where: { name } });
    this.cache.delete(name);
    this.log.warn(`Credential ${name} cleared by ${updatedBy}`);
    return this.list();
  }
}
