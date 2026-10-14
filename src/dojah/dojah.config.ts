import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredentialsService } from '../common/credentials.service';
import { DojahError } from './dojah.errors';

export const DOJAH_SANDBOX_URL = 'https://sandbox.dojah.io';
/** A paid call claimed longer ago than this, still IN_FLIGHT, is UNKNOWN (spec §14.5). */
export const LEASE_MS = 5 * 60_000;
/** Retries for an AML screen that DEFINITELY failed: free under plan §R1.1. */
export const AML_BACKOFF_MS = [2 * 60_000, 10 * 60_000, 20 * 60_000] as const;
/** Exact per-call deadlines. Worst latency seen in the sandbox was 2.1 s. */
export const DEADLINES = { lookup: 15_000, aml: 30_000, balance: 8_000 } as const;

/**
 * Dojah settings. The mode guards (mock only in development/test, live URL only
 * in production, https outside development) are enforced at startup by env
 * validation; this class only reads.
 */
@Injectable()
export class DojahConfig {
  constructor(
    private readonly config: ConfigService,
    private readonly creds: CredentialsService,
  ) {}

  get nodeEnv(): string {
    return this.config.get<string>('NODE_ENV') ?? 'development';
  }

  get useMock(): boolean {
    return this.config.get<boolean>('DOJAH_USE_MOCK') ?? true;
  }

  get baseUrl(): string {
    return (this.config.get<string>('DOJAH_BASE_URL') ?? DOJAH_SANDBOX_URL).replace(/\/+$/, '');
  }

  get basicEnabled(): boolean {
    return this.config.get<boolean>('KYC_BASIC_ENABLED') === true;
  }

  get dailyAttempts(): number {
    return this.config.get<number>('KYC_BASIC_DAILY_ATTEMPTS') ?? 3;
  }

  get totalAttempts(): number {
    return this.config.get<number>('KYC_BASIC_TOTAL_ATTEMPTS') ?? 10;
  }

  /** Naira. Production requires it (env validation); elsewhere 0, because the sandbox wallet is always 0.00. */
  get minBalance(): number {
    const raw = this.config.get<string>('DOJAH_MIN_BALANCE');
    return raw ? Number(raw) : 0;
  }

  get lowBalanceWarn(): number | null {
    const raw = this.config.get<string>('DOJAH_LOW_BALANCE_WARN');
    return raw ? Number(raw) : null;
  }

  async credentials(): Promise<{ appId: string; secretKey: string }> {
    const [appId, secretKey] = await Promise.all([this.creds.get('dojah.appId'), this.creds.get('dojah.secretKey')]);
    if (!appId || !secretKey) throw new DojahError('CONFIG', 'The Dojah app ID or secret key is not set', 0);
    return { appId, secretKey };
  }
}
