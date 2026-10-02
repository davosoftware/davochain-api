import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/** The admin override for naira bank withdrawals. No row means "use the server setting". */
export const NGN_WITHDRAWALS_FLAG = 'ngn_withdrawals_enabled';

/** What a user is told while naira withdrawals are switched off. */
export const NGN_WITHDRAWALS_OFF_MESSAGE = 'Naira withdrawals are temporarily unavailable.';

export interface NgnWithdrawalsState {
  /** What is in force right now. */
  enabled: boolean;
  /** Where that comes from: an admin's override, or NGN_WITHDRAWALS_ENABLED. */
  source: 'override' | 'server';
  /** NGN_WITHDRAWALS_ENABLED as this server was started with it. */
  serverSetting: boolean;
  /** When the override was set and by which admin id; null on the server setting. */
  updatedAt: Date | null;
  updatedBy: string | null;
}

/**
 * Kill switches. There is no rollback on live, so every money path checks
 * these before it does anything — and a pause takes effect on the next
 * request, not the next deploy.
 */
@Injectable()
export class SystemFlagsService {
  private readonly log = new Logger(SystemFlagsService.name);
  private cache = new Map<string, { value: unknown; expiresAt: number }>();
  private static readonly TTL_MS = 5_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;

    const row = await this.prisma.systemFlag.findUnique({ where: { key } });
    const value = (row?.value ?? fallback) as T;
    this.cache.set(key, { value, expiresAt: Date.now() + SystemFlagsService.TTL_MS });
    return value;
  }

  async set(key: string, value: unknown, updatedBy: string): Promise<void> {
    await this.prisma.systemFlag.upsert({
      where: { key },
      create: { key, value: value as never, updatedBy },
      update: { value: value as never, updatedBy },
    });
    this.cache.delete(key);
    this.log.warn(`Flag ${key} set to ${JSON.stringify(value)} by ${updatedBy}`);
  }

  /** Throws unless trading is enabled globally AND this asset is not paused. */
  async assertTradingAllowed(assetCode: string): Promise<void> {
    if (!(await this.get<boolean>('trading_enabled', true))) {
      throw new ForbiddenException('Trading is temporarily paused. Please try again shortly.');
    }
    const paused = await this.get<string[]>('paused_assets', []);
    if (paused.includes(assetCode)) {
      throw new ForbiddenException(
        `${assetCode.toUpperCase()} is temporarily unavailable for trading.`,
      );
    }
  }

  async assertDepositsAllowed(): Promise<void> {
    if (!(await this.get<boolean>('deposits_enabled', true))) {
      throw new ForbiddenException('Deposits are temporarily paused.');
    }
  }

  async assertWithdrawalsAllowed(): Promise<void> {
    if (!(await this.get<boolean>('withdrawals_enabled', true))) {
      throw new ForbiddenException('Withdrawals are temporarily paused.');
    }
  }

  /** NGN_WITHDRAWALS_ENABLED from the server's environment. Off when unset. */
  ngnServerSetting(): boolean {
    return this.config.get<boolean>('NGN_WITHDRAWALS_ENABLED') === true;
  }

  /**
   * Naira bank withdrawals on or off: an admin's override if there is one,
   * otherwise the server setting. Only a literal `true` override counts as
   * on — a row hand-edited into "true" or 1 fails safe rather than paying out.
   */
  async ngnWithdrawalsEnabled(): Promise<boolean> {
    const override = await this.get<unknown>(NGN_WITHDRAWALS_FLAG, null);
    if (override === null) return this.ngnServerSetting();
    return override === true;
  }

  async assertNgnWithdrawalsAllowed(): Promise<void> {
    if (!(await this.ngnWithdrawalsEnabled())) {
      throw new ForbiddenException(NGN_WITHDRAWALS_OFF_MESSAGE);
    }
  }

  async setNgnWithdrawalsOverride(enabled: boolean, by: string): Promise<void> {
    await this.set(NGN_WITHDRAWALS_FLAG, enabled, by);
  }

  /** Drop the override so NGN_WITHDRAWALS_ENABLED applies again. */
  async clearNgnWithdrawalsOverride(by: string): Promise<void> {
    await this.prisma.systemFlag.deleteMany({ where: { key: NGN_WITHDRAWALS_FLAG } });
    this.cache.delete(NGN_WITHDRAWALS_FLAG);
    this.log.warn(`Flag ${NGN_WITHDRAWALS_FLAG} override cleared by ${by}; the server setting applies`);
  }

  /** Uncached: the admin screen shows what is stored, not a copy up to 5s old. */
  async ngnWithdrawalsState(): Promise<NgnWithdrawalsState> {
    const serverSetting = this.ngnServerSetting();
    const row = await this.prisma.systemFlag.findUnique({ where: { key: NGN_WITHDRAWALS_FLAG } });
    if (!row || row.value === null) {
      return { enabled: serverSetting, source: 'server', serverSetting, updatedAt: null, updatedBy: null };
    }
    return {
      enabled: row.value === true,
      source: 'override',
      serverSetting,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  /** Used by the margin-deviation trip and by the NGN-fuel critical alert. */
  async pauseAsset(assetCode: string, by: string, reason: string): Promise<void> {
    const paused = await this.get<string[]>('paused_assets', []);
    if (!paused.includes(assetCode)) {
      await this.set('paused_assets', [...paused, assetCode], by);
      this.log.error(`AUTO-PAUSED ${assetCode}: ${reason}`);
    }
  }

  async resumeAsset(assetCode: string, by: string): Promise<void> {
    const paused = await this.get<string[]>('paused_assets', []);
    await this.set(
      'paused_assets',
      paused.filter((a) => a !== assetCode),
      by,
    );
  }
}
