import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { KycStatus, KycTier, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JobLeaseService } from '../common/job-lease.service';
import { redactIds } from '../common/redact';
import { ReadinessService } from './readiness.service';
import { VirtualAccountsService } from './virtual-accounts.service';
import { ServerSettingsService } from '../settings/server-settings.service';

const MINUTE = 60_000;
/** Customers per run. Payrep rate-limits us, so a steady trickle beats a burst. */
const BATCH = 20;
const DAY = 24 * 60 * MINUTE;
const MAX_ATTEMPTS = 5;

export const OPENER_OPTIONS = Symbol('OPENER_OPTIONS');

/**
 * The background opener (spec 2026-10-23 §4.1).
 *
 * Every minute, verified customers without a naira account get one, without
 * having to ask: right after Basic is approved (automatically or by an admin),
 * and for anyone approved before this existed. One customer at a time, under a
 * lease so one server does it. All the safety lives in
 * VirtualAccountsService.ensure: one attempt at a time, never a blind second
 * account after a lost answer.
 */
@Injectable()
export class AccountOpenerService {
  private readonly log = new Logger(AccountOpenerService.name);
  private readonly pauseMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: VirtualAccountsService,
    private readonly readiness: ReadinessService,
    private readonly leases: JobLeaseService,
    @Optional() @Inject(OPENER_OPTIONS) opts?: { pauseMs?: number },
    @Optional() private readonly config?: ConfigService,
    /** Live values from System → Server settings (spec 2026-10-26); .env when absent. */
    @Optional() private readonly settings?: ServerSettingsService,
  ) {
    this.pauseMs = opts?.pauseMs ?? 500;
  }

  @Cron('* * * * *', { name: 'ngn-account-opener' })
  async cron(): Promise<void> {
    try {
      await this.leases.run('ngn-account-opener', 5 * MINUTE, () => this.run());
    } catch (err) {
      this.log.error(`Account opener failed: ${redactIds((err as Error).message)}`);
    }
  }

  async run(): Promise<{ tried: number }> {
    // Off only on purpose (e.g. a test server pointed at Payrep's sandbox and a database full of test customers).
    if ((this.settings ? this.settings.get<boolean>('NGN_ACCOUNT_AUTO_OPEN') : this.config?.get<boolean>('NGN_ACCOUNT_AUTO_OPEN')) === false) return { tried: 0 };
    const ready = await this.readiness.report();
    if (!ready.depositsEnabled || !ready.canCreateAccounts) return { tried: 0 };

    // Waiting for a person, or out of tries today: leave them, so they can't crowd out everyone else.
    const now = Date.now();
    const blocked = await this.prisma.virtualAccountRequest.findMany({
      where: {
        OR: [
          { state: 'NEEDS_PERSON', stateSince: { gt: new Date(now - DAY) } },
          { attemptsInWindow: { gte: MAX_ATTEMPTS }, windowStartedAt: { gt: new Date(now - DAY) } },
        ],
      },
      select: { userId: true },
    });

    const users = await this.prisma.user.findMany({
      where: {
        status: UserStatus.ACTIVE,
        kycStatus: KycStatus.APPROVED,
        kycTier: { in: [KycTier.TIER_1, KycTier.TIER_2, KycTier.TIER_3] },
        amlStatus: 'CLEAR',
        virtualAccounts: { none: {} },
        ...(blocked.length ? { id: { notIn: blocked.map((b) => b.userId) } } : {}),
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    });

    for (const [i, u] of users.entries()) {
      try {
        await this.accounts.ensure(u.id, 'AUTO');
      } catch (err) {
        this.log.warn(`Could not open a naira account for ${u.id}: ${redactIds((err as Error).message)}`);
      }
      if (this.pauseMs && i < users.length - 1) await new Promise((r) => setTimeout(r, this.pauseMs));
    }
    return { tried: users.length };
  }
}
