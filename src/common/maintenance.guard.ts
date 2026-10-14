import { CanActivate, ExecutionContext, Inject, Injectable, Logger, Optional, ServiceUnavailableException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';

export const PAUSED_IN_MAINTENANCE = 'pausedInMaintenance';
export const MAINTENANCE_DEFAULT_MESSAGE = 'DavoChain is under maintenance. Please try again shortly.';
/** A clock, injectable only by tests. */
export const MAINTENANCE_CLOCK = Symbol('MAINTENANCE_CLOCK');

/**
 * Marks a route that moves money or starts a paid check. While an admin has
 * maintenance mode on (System → Site settings), it answers 503 instead.
 * Sign-in, balances, history, the dashboard and provider webhooks are never
 * marked, so nobody is locked out and no incoming money is lost.
 */
export const PausedDuringMaintenance = () => SetMetadata(PAUSED_IN_MAINTENANCE, true);

const SINGLETON = 'default';
const CACHE_MS = 5_000;

/** Enforces the maintenance switch that, until now, only the app read (FLUTTER_API Appendix F #15). */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  private readonly log = new Logger(MaintenanceGuard.name);
  private cached: { at: number; active: boolean; message: string | null } | null = null;
  private readonly now: () => number;

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    @Optional() @Inject(MAINTENANCE_CLOCK) now?: () => number,
  ) {
    this.now = now ?? Date.now;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const paused = this.reflector.getAllAndOverride<boolean>(PAUSED_IN_MAINTENANCE, [ctx.getHandler(), ctx.getClass()]);
    if (!paused) return true;
    const state = await this.state();
    if (!state.active) return true;
    throw new ServiceUnavailableException({ statusCode: 503, code: 'MAINTENANCE', message: state.message || MAINTENANCE_DEFAULT_MESSAGE });
  }

  private async state(): Promise<{ active: boolean; message: string | null }> {
    if (this.cached && this.now() - this.cached.at < CACHE_MS) return this.cached;
    try {
      const row = await this.prisma.siteSetting.findUnique({
        where: { id: SINGLETON },
        select: { maintenanceMode: true, maintenanceMessage: true },
      });
      this.cached = { at: this.now(), active: row?.maintenanceMode === true, message: row?.maintenanceMessage ?? null };
    } catch (err) {
      // Fail open: the switch is a convenience, and every money route has its own
      // safety checks. A database blip must not, by itself, stop all trading.
      this.log.warn(`Could not read maintenance mode: ${(err as Error).message}`);
      return { active: false, message: null };
    }
    return this.cached;
  }
}
