import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/**
 * How long a session survives with nobody touching it.
 *
 * An admin dashboard left open on an unlocked machine is the whole risk here,
 * and it is a desk risk rather than a network one — so the clock runs on
 * inactivity, not on age.
 */
const DEFAULT_IDLE_MINUTES = 30;

/**
 * Writing lastSeenAt on every request would mean a row update per click for no
 * benefit. A minute of granularity is far finer than a thirty-minute timeout
 * needs, and it turns a hot write into a rare one.
 */
const TOUCH_INTERVAL_MS = 60_000;

export interface SessionCheck {
  ok: boolean;
  reason?: 'revoked' | 'idle' | 'expired' | 'unknown';
}

@Injectable()
export class AdminSessionsService {
  private readonly log = new Logger(AdminSessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  get idleMs(): number {
    const minutes = this.config.get<number>('ADMIN_IDLE_TIMEOUT_MINUTES') ?? DEFAULT_IDLE_MINUTES;
    return minutes * 60_000;
  }

  async start(params: {
    adminUserId: string;
    jti: string;
    expiresAt: Date;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.prisma.adminSession.create({
      data: {
        jti: params.jti,
        adminUserId: params.adminUserId,
        expiresAt: params.expiresAt,
        ip: params.ip ?? null,
        userAgent: params.userAgent?.slice(0, 500) ?? null,
      },
    });
  }

  /**
   * Is this token still a live session, and if so, mark it used.
   *
   * Returns a reason rather than a bare false so the API can tell somebody why
   * they are back at the login screen. "You were signed out after 30 minutes"
   * is a different message from "your password changed".
   */
  async touch(jti: string): Promise<SessionCheck> {
    const session = await this.prisma.adminSession.findUnique({
      where: { jti },
      select: { id: true, lastSeenAt: true, expiresAt: true, revokedAt: true },
    });
    if (!session) return { ok: false, reason: 'unknown' };
    if (session.revokedAt) return { ok: false, reason: 'revoked' };

    const now = Date.now();
    if (session.expiresAt.getTime() <= now) return { ok: false, reason: 'expired' };

    if (now - session.lastSeenAt.getTime() > this.idleMs) {
      // Close it rather than leaving it to be re-checked on every later
      // request: once idled out, it is over.
      await this.prisma.adminSession.update({
        where: { id: session.id },
        data: { revokedAt: new Date(), revokedWhy: 'idle' },
      });
      return { ok: false, reason: 'idle' };
    }

    if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.prisma.adminSession.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date() },
      });
    }

    return { ok: true };
  }

  /** How long this session has left before idling out. Drives the UI warning. */
  async remainingMs(jti: string): Promise<number | null> {
    const session = await this.prisma.adminSession.findUnique({
      where: { jti },
      select: { lastSeenAt: true, revokedAt: true },
    });
    if (!session || session.revokedAt) return null;
    return Math.max(0, this.idleMs - (Date.now() - session.lastSeenAt.getTime()));
  }

  async revoke(jti: string, why: string): Promise<void> {
    await this.prisma.adminSession.updateMany({
      where: { jti, revokedAt: null },
      data: { revokedAt: new Date(), revokedWhy: why },
    });
  }

  /**
   * End every session for an admin, optionally sparing the one doing the ending
   * — a password change should not sign out the person changing it.
   */
  async revokeAllFor(adminUserId: string, why: string, exceptJti?: string): Promise<number> {
    const result = await this.prisma.adminSession.updateMany({
      where: {
        adminUserId,
        revokedAt: null,
        ...(exceptJti ? { jti: { not: exceptJti } } : {}),
      },
      data: { revokedAt: new Date(), revokedWhy: why },
    });
    if (result.count > 0) {
      this.log.warn(`Revoked ${result.count} session(s) for ${adminUserId}: ${why}`);
    }
    return result.count;
  }

  /** Live sessions, for the settings screen. */
  async listFor(adminUserId: string, currentJti?: string) {
    const rows = await this.prisma.adminSession.findMany({
      where: { adminUserId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true, jti: true, createdAt: true, lastSeenAt: true, ip: true, userAgent: true },
    });
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      ip: r.ip,
      userAgent: r.userAgent,
      isCurrent: r.jti === currentJti,
    }));
  }
}
