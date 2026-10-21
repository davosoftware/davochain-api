import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredentialsService } from '../common/credentials.service';
import { PayrepError } from './payrep.errors';
import { payrepKeyModeProblem } from './key-mode';

export const PAYREP_SANDBOX_URL = 'https://shogun-dev.payrepmfb.com';
export const PAYREP_LIVE_URL = 'https://baasapi.payrepmfb.com';
/** Only ever used with the mock, so local development needs no Payrep setup. */
export const MOCK_WEBHOOK_SECRET = '6d6f636b2d70617972657024776562686f6f6b2d7365637265742d6f6e6c7921';
/** The pretend main account, used only with the mock when PAYREP_MAIN_ACCOUNT is empty. */
export const MOCK_MAIN_ACCOUNT = '7800000000';
const blank = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

/** Payrep settings. Secrets come from CredentialsService (System → API keys, then api/.env). */
@Injectable()
export class PayrepConfig {
  constructor(
    private readonly config: ConfigService,
    private readonly creds: CredentialsService,
  ) {}

  get useMock(): boolean {
    return this.config.get<boolean>('PAYREP_USE_MOCK') !== false;
  }

  get baseUrl(): string {
    return (blank(this.config.get<string>('PAYREP_BASE_URL')) ?? PAYREP_SANDBOX_URL).replace(/\/+$/, '');
  }

  get nodeEnv(): string {
    return this.config.get<string>('NODE_ENV') ?? 'development';
  }

  /** Our own API port, for the mock to deliver webhooks to. */
  get port(): number {
    return this.config.get<number>('PORT') ?? 3000;
  }

  /**
   * Our main (business wallet) account: the source of every transfer and the
   * pool for customer accounts. The mock stands one in, so local development
   * works with an empty .env.
   */
  get mainAccount(): string | null {
    return blank(this.config.get<string>('PAYREP_MAIN_ACCOUNT')) ?? (this.useMock ? MOCK_MAIN_ACCOUNT : null);
  }

  /** The key pair in force. Refused if missing or the wrong mode for this environment; never names a key. */
  async credentials(): Promise<{ clientId: string; clientSecret: string }> {
    const [id, secret] = await Promise.all([this.creds.get('payrep.clientId'), this.creds.get('payrep.clientSecret')]);
    const clientId = blank(id);
    const clientSecret = blank(secret);
    if (!clientId || !clientSecret) throw new PayrepError('CONFIG', 'The Payrep client ID or secret is not set', 0, null);
    const problem = payrepKeyModeProblem(clientId, clientSecret, this.nodeEnv);
    if (problem) throw new PayrepError('CONFIG', problem, 0, null);
    return { clientId, clientSecret };
  }

  /** The secret that signs webhooks. Null means: refuse every webhook. */
  async webhookSecret(): Promise<string | null> {
    if (this.useMock) return MOCK_WEBHOOK_SECRET;
    return blank(await this.creds.get('payrep.webhookSecret'));
  }

  /** For readiness: are keys present, and allowed here? Never the keys themselves. */
  async keyStatus(): Promise<{ present: boolean; problem: string | null }> {
    const [id, secret] = await Promise.all([this.creds.get('payrep.clientId'), this.creds.get('payrep.clientSecret')]);
    const clientId = blank(id);
    const clientSecret = blank(secret);
    if (!clientId || !clientSecret) return { present: false, problem: null };
    return { present: true, problem: payrepKeyModeProblem(clientId, clientSecret, this.nodeEnv) };
  }
}
