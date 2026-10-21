import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredentialsService } from '../common/credentials.service';
import { PrismaService } from '../prisma/prisma.service';
import { DojahError } from './dojah.errors';

export const DOJAH_SANDBOX_URL = 'https://sandbox.dojah.io';
/** The system_flags row the Dojah screen saves to (same table as the naira payouts switch). */
export const DOJAH_SETTINGS_FLAG = 'dojah_settings';

export type DojahSettingKey =
  | 'minBalance'
  | 'lowBalanceWarn'
  | 'dailyAttempts'
  | 'totalAttempts'
  | 'basicEnabled'
  | 'advancedEnabled'
  | 'advancedDailyAttempts'
  | 'advancedTotalAttempts'
  | 'livenessMin'
  | 'faceMatchPass'
  | 'faceMatchReview'
  | 'addressRecencyMonths';
export interface DojahSettings {
  minBalance: number;
  lowBalanceWarn: number | null;
  dailyAttempts: number;
  totalAttempts: number;
  basicEnabled: boolean;
  advancedEnabled: boolean;
  advancedDailyAttempts: number;
  advancedTotalAttempts: number;
  /** Dojah liveness_probability at or above this, with liveness_check true, passes. */
  livenessMin: number;
  /** Face match confidence at or above this passes; from faceMatchReview up to it goes to a person. */
  faceMatchPass: number;
  faceMatchReview: number;
  /** A proof-of-address document must be issued within this many months. */
  addressRecencyMonths: number;
  /** Where each value came from: set on the Dojah screen, or the server default in api/.env. */
  source: Record<DojahSettingKey, 'screen' | 'server'>;
}

const wholeAtLeast = (min: number) => (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min;
const wholeBetween = (min: number, max: number) => (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
/** Spec 2026-10-21 §5.3 defaults. Changed only from the Dojah screen (owners). */
export const ADVANCED_DEFAULTS = {
  advancedDailyAttempts: 3,
  advancedTotalAttempts: 10,
  livenessMin: 90,
  faceMatchPass: 75,
  faceMatchReview: 60,
  addressRecencyMonths: 3,
} as const;
const VALID: Record<DojahSettingKey, (v: unknown) => boolean> = {
  minBalance: wholeAtLeast(0),
  lowBalanceWarn: wholeAtLeast(0),
  dailyAttempts: wholeAtLeast(1),
  totalAttempts: wholeAtLeast(1),
  basicEnabled: (v) => typeof v === 'boolean',
  advancedEnabled: (v) => typeof v === 'boolean',
  advancedDailyAttempts: wholeBetween(1, 20),
  advancedTotalAttempts: wholeBetween(1, 20),
  livenessMin: wholeBetween(50, 100),
  faceMatchPass: wholeBetween(60, 100),
  faceMatchReview: wholeBetween(60, 100),
  addressRecencyMonths: wholeBetween(1, 12),
};
/** A paid call claimed longer ago than this, still IN_FLIGHT, is UNKNOWN (spec §14.5). */
export const LEASE_MS = 5 * 60_000;
/** Retries for an AML screen that DEFINITELY failed: free under plan §R1.1. */
export const AML_BACKOFF_MS = [2 * 60_000, 10 * 60_000, 20 * 60_000] as const;
/** Exact per-call deadlines. Worst latency seen in the sandbox was 2.1 s. */
export const DEADLINES = { lookup: 15_000, aml: 30_000, balance: 8_000, readId: 30_000, liveness: 20_000, faceMatch: 20_000, utilityBill: 30_000, ocr: 30_000 } as const;

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
    private readonly prisma: PrismaService,
  ) {}

  /**
   * What actually applies right now: a value saved on the Dojah screen, else the
   * server default from api/.env. Read fresh on every call (no cache), so a change
   * on the screen applies to the very next request. A stored value that is not
   * valid is ignored for that field only.
   */
  async effective(): Promise<DojahSettings> {
    const row = await this.prisma.systemFlag.findUnique({ where: { key: DOJAH_SETTINGS_FLAG } });
    const stored = (row?.value && typeof row.value === 'object' ? row.value : {}) as Record<string, unknown>;
    const server = {
      minBalance: this.minBalance,
      lowBalanceWarn: this.lowBalanceWarn,
      dailyAttempts: this.dailyAttempts,
      totalAttempts: this.totalAttempts,
      basicEnabled: this.basicEnabled,
      advancedEnabled: this.advancedEnabled,
      ...ADVANCED_DEFAULTS,
    };
    const out = { ...server, source: {} as DojahSettings['source'] };
    for (const key of Object.keys(VALID) as DojahSettingKey[]) {
      if (VALID[key](stored[key])) {
        (out as Record<string, unknown>)[key] = stored[key];
        out.source[key] = 'screen';
      } else {
        out.source[key] = 'server';
      }
    }
    // A stored review floor above the pass mark would make "review" unreachable: fall back.
    if (out.faceMatchReview > out.faceMatchPass) {
      out.faceMatchReview = ADVANCED_DEFAULTS.faceMatchReview;
      out.source.faceMatchReview = 'server';
    }
    return out;
  }

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

  get advancedEnabled(): boolean {
    return this.config.get<boolean>('KYC_ADVANCED_ENABLED') === true;
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
