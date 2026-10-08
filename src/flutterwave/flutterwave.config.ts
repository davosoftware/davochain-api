import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredentialsService } from '../common/credentials.service';
import { FlutterwaveError } from './flutterwave.errors';
import { keyModeProblem } from './key-mode';

export const FLW_DEFAULT_BASE_URL = 'https://api.flutterwave.com/v3';
/** Only ever used with the mock, so local development needs no dashboard setup. */
export const MOCK_WEBHOOK_HASH = 'davochain-mock-webhook-hash';

/**
 * Everything the Flutterwave code needs to know about its own configuration.
 *
 * Secrets come from CredentialsService — encrypted in the database, with the
 * environment as the fallback — and are checked against the key-mode guard on
 * every use, so a key pasted into System → API keys gets the same protection as
 * one in .env.
 */
@Injectable()
export class FlutterwaveConfig {
  constructor(
    private readonly config: ConfigService,
    private readonly credentials: CredentialsService,
  ) {}

  get useMock(): boolean {
    return this.config.get<boolean>('FLW_USE_MOCK') === true;
  }

  get baseUrl(): string {
    return (this.config.get<string>('FLW_BASE_URL') ?? FLW_DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  get nodeEnv(): string {
    return this.config.get<string>('NODE_ENV') ?? 'development';
  }

  get rateLimitPerMinute(): number {
    return this.config.get<number>('FLW_RATE_LIMIT_PER_MINUTE') ?? 120;
  }

  /** Our own API port, for the mock to deliver webhooks to. */
  get port(): number {
    return this.config.get<number>('PORT') ?? 3000;
  }

  /** The secret key in force. Refused if missing or the wrong mode for this environment. */
  async secretKey(): Promise<string> {
    const key = await this.credentials.get('flutterwave.secretKey');
    if (!key) throw new FlutterwaveError('CONFIG', 'The Flutterwave secret key is not set', 0);
    const problem = keyModeProblem(key, this.nodeEnv);
    if (problem) throw new FlutterwaveError('CONFIG', problem, 0);
    return key;
  }

  /** What a genuine webhook carries in `verif-hash`. Null means: reject every webhook. */
  async secretHash(): Promise<string | null> {
    const hash = await this.credentials.get('flutterwave.secretHash');
    if (hash) return hash;
    return this.useMock ? MOCK_WEBHOOK_HASH : null;
  }

  /** For readiness: is a key present, and is it allowed here? Never the key itself. */
  async keyStatus(): Promise<{ present: boolean; problem: string | null }> {
    const key = await this.credentials.get('flutterwave.secretKey');
    if (!key) return { present: false, problem: null };
    return { present: true, problem: keyModeProblem(key, this.nodeEnv) };
  }
}
