import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AlertType, CollectionOutcome } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JobLeaseService } from '../common/job-lease.service';
import { lagosDate } from '../common/dates';
import { redactIds } from '../common/redact';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { PayrepApi } from '../payrep/payrep.api';
import { PayrepError } from '../payrep/payrep.errors';
import type { PayrepCursor } from '../payrep/payrep.types';
import { PayInService, SETTLED_OUTCOMES } from './pay-in.service';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_PAGES = 100;
const SWEEP_BUDGET_MS = 20 * MINUTE;
type CreditsPage = Awaited<ReturnType<PayrepApi['fetchCredits']>>;

export interface SweepResult {
  status: 'OK' | 'PARTIAL';
  pages: number;
  seen: number;
  queued: number;
  error: string | null;
}

/**
 * The nets under the webhook (spec 2026-10-20 §6).
 *
 * Sweep: every 30 minutes, list the last two days of credits at Payrep and hand
 * on any into our accounts not yet settled. Webhooks can be missed; this is not.
 * Re-check: payments still unverified or pending get looked at again. Each runs
 * under a lease, so one replica runs it.
 */
@Injectable()
export class SweepService {
  private readonly log = new Logger(SweepService.name);
  private consecutivePartials = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payrep: PayrepApi,
    private readonly payIn: PayInService,
    private readonly leases: JobLeaseService,
    private readonly alerts: OpsAlertsService,
  ) {}

  @Cron('*/30 * * * *', { name: 'naira-sweep' })
  async sweepCron(): Promise<void> {
    try {
      if (!(await this.railInUse())) return;
      const out = await this.leases.run('naira-sweep', 25 * MINUTE, () => this.sweep());
      if (out.ran) {
        if (out.result.status === 'PARTIAL') {
          this.consecutivePartials++;
          if (this.consecutivePartials >= 2) {
            await this.alerts.raise(AlertType.NGN_RECONCILIATION, 'naira-sweep-partial', 'The Payrep missed-deposit sweep is not completing', [
              out.result.error ?? 'unknown',
              'Deposits whose webhook was missed may stay uncredited until it completes.',
            ]);
          }
        } else {
          this.consecutivePartials = 0;
        }
      }
    } catch (err) {
      this.log.error(`Sweep failed: ${redactIds((err as Error).message)}`);
    }
  }

  @Cron('15,45 * * * *', { name: 'naira-recheck' })
  async recheckCron(): Promise<void> {
    try {
      await this.leases.run('naira-recheck', 10 * MINUTE, () => this.recheck());
    } catch (err) {
      this.log.error(`Re-check failed: ${redactIds((err as Error).message)}`);
    }
  }

  async sweep(now = new Date()): Promise<SweepResult> {
    const startDate = lagosDate(new Date(now.getTime() - 2 * DAY));
    const endDate = lagosDate(new Date(now.getTime() + DAY));
    const ours = new Set((await this.prisma.virtualAccount.findMany({ select: { accountNumber: true } })).map((a) => a.accountNumber));
    let pages = 0;
    let seen = 0;
    let queued = 0;
    const started = Date.now();
    let cursor: PayrepCursor | null = null;
    try {
      do {
        if (pages > 0 && Date.now() - started > SWEEP_BUDGET_MS) {
          const error = `Stopped at the 20-minute budget after ${pages} page(s)`;
          this.log.warn(error);
          return { status: 'PARTIAL', pages, seen, queued, error };
        }
        if (pages >= MAX_PAGES) {
          const error = `Stopped at the ${MAX_PAGES}-page limit`;
          this.log.warn(error);
          return { status: 'PARTIAL', pages, seen, queued, error };
        }
        const res: CreditsPage = await this.payrep.fetchCredits({ startDate, endDate }, cursor);
        pages++;
        for (const c of res.items) {
          seen++;
          if (!c.accountNumber || !ours.has(c.accountNumber)) continue;
          const row = await this.prisma.nairaCollection.findUnique({ where: { providerTransactionId: c.transactionId } });
          if (row && SETTLED_OUTCOMES.includes(row.outcome)) continue;
          await this.payIn.intake({ transactionId: c.transactionId, accountNumber: c.accountNumber, referenceNumber: c.referenceNumber, createdAt: c.createdAt, event: 'sweep' }, 'SWEEP');
          queued++;
        }
        cursor = res.next;
      } while (cursor);
      if (queued > 0) this.log.log(`Sweep queued ${queued} payment(s) from ${pages} page(s)`);
      return { status: 'OK', pages, seen, queued, error: null };
    } catch (err) {
      const error = redactIds((err as Error).message);
      this.log.warn(`Sweep stopped after ${pages} page(s): ${error}`);
      if (err instanceof PayrepError && err.kind === 'CONFIG') {
        await this.alerts.raise(AlertType.NAIRA_RAIL_CONFIG, 'config', 'Payrep refused the missed-deposit sweep', [error]);
      }
      return { status: 'PARTIAL', pages, seen, queued, error };
    }
  }

  async recheck(now = new Date()): Promise<{ queued: number }> {
    const stale = new Date(now.getTime() - 10 * MINUTE);
    const rows = await this.prisma.nairaCollection.findMany({
      where: {
        outcome: { in: [CollectionOutcome.UNVERIFIED, CollectionOutcome.PENDING_PROVIDER] },
        firstSeenAt: { gte: new Date(now.getTime() - 8 * DAY) },
        OR: [{ lastCheckedAt: null, firstSeenAt: { lt: stale } }, { lastCheckedAt: { lt: stale } }],
      },
      orderBy: { firstSeenAt: 'asc' },
      take: 200,
    });
    for (const row of rows) await this.payIn.enqueue(row.providerTransactionId, 'RECHECK');
    if (rows.length > 0) this.log.log(`Re-check queued ${rows.length} payment(s)`);
    return { queued: rows.length };
  }

  /** No account, and no attempt at one: nothing can have been paid in. */
  private async railInUse(): Promise<boolean> {
    if ((await this.prisma.virtualAccount.count()) > 0) return true;
    return (await this.prisma.virtualAccountRequest.count()) > 0;
  }
}
