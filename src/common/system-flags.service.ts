import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

  constructor(private readonly prisma: PrismaService) {}

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
