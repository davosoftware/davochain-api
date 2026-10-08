import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AlertType, CollectionOutcome } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JobLeaseService } from '../common/job-lease.service';
import { lagosDate } from '../common/dates';
import { FlutterwaveClient } from '../flutterwave/flutterwave.client';
import { FlutterwaveError, redactIds } from '../flutterwave/flutterwave.errors';
import { OpsAlertsService } from './ops-alerts.service';
import { PayInService, SETTLED_OUTCOMES } from './pay-in.service';
import { hasOurPrefix } from './tx-ref';
import { VirtualAccountsService } from './virtual-accounts.service';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_PAGES = 500;
const SWEEP_BUDGET_MS = 20 * MINUTE;
const NUMERIC_ID = /^\d{1,19}$/;

export interface SweepResult {
  status: 'OK' | 'PARTIAL';
  pages: number;
  seen: number;
  queued: number;
  error: string | null;
}

/**
 * The nets under the webhook (spec §6.6).
 *
 * Sweep: every 30 minutes, list recent successful NGN payments at Flutterwave
 * and queue any of ours not yet settled. Webhooks stop after three retries; this
 * does not. Re-check: payments still unverified or pending get looked at again.
 * Sync: virtual accounts whose Flutterwave status differs from ours are pushed
 * again. Each runs under a lease, so one replica runs it.
 */
@Injectable()
export class SweepService {
  private readonly log = new Logger(SweepService.name);
  private consecutivePartials = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: FlutterwaveClient,
    private readonly payIn: PayInService,
    private readonly accounts: VirtualAccountsService,
    private readonly leases: JobLeaseService,
    private readonly alerts: OpsAlertsService,
  ) {}

  @Cron('*/30 * * * *', { name: 'flutterwave-sweep' })
  async sweepCron(): Promise<void> {
    try {
      if (!(await this.railInUse())) return;
      const out = await this.leases.run('flutterwave-sweep', 25 * MINUTE, () => this.sweep());
      if (out.ran) {
        if (out.result.status === 'PARTIAL') {
          this.consecutivePartials++;
          if (this.consecutivePartials >= 2) {
            await this.alerts.raise(
              AlertType.NGN_RECONCILIATION,
              'flutterwave-sweep-partial',
              'The Flutterwave missed-webhook sweep is not completing',
              [out.result.error ?? 'unknown', 'Deposits whose webhook was missed may stay uncredited until it completes; the settlement backstop is the net.'],
            );
          }
        } else {
          this.consecutivePartials = 0;
        }
      }
    } catch (err) {
      this.log.error(`Sweep failed: ${redactIds((err as Error).message)}`);
    }
  }

  @Cron('15,45 * * * *', { name: 'flutterwave-recheck' })
  async recheckCron(): Promise<void> {
    try {
      await this.leases.run('flutterwave-recheck', 10 * MINUTE, () => this.recheck());
    } catch (err) {
      this.log.error(`Re-check failed: ${redactIds((err as Error).message)}`);
    }
  }

  @Cron('*/10 * * * *', { name: 'virtual-account-sync' })
  async syncCron(): Promise<void> {
    try {
      await this.leases.run('virtual-account-sync', 8 * MINUTE, () => this.accounts.syncStatuses());
    } catch (err) {
      this.log.error(`Virtual-account sync failed: ${redactIds((err as Error).message)}`);
    }
  }

  async sweep(now = new Date()): Promise<SweepResult> {
    const from = lagosDate(new Date(now.getTime() - 2 * DAY));
    const to = lagosDate(new Date(now.getTime() + DAY));
    let pages = 0;
    let seen = 0;
    let queued = 0;
    const started = Date.now();
    try {
      let totalPages = 1;
      for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page++) {
        if (page > 1 && Date.now() - started > SWEEP_BUDGET_MS) {
          const error = `Stopped at the 20-minute budget after ${pages} page(s)`;
          this.log.warn(error);
          return { status: 'PARTIAL', pages, seen, queued, error };
        }
        const res = await this.client.listTransactions({ from, to, page, status: 'successful', currency: 'NGN' });
        pages++;
        totalPages = res.totalPages;
        for (const item of res.items) {
          seen++;
          const id = String(item.id);
          if (!NUMERIC_ID.test(id)) continue;
          if ((item.payment_type ?? '').toLowerCase() !== 'bank_transfer') continue;
          if (!hasOurPrefix(item.tx_ref)) continue;
          const row = await this.prisma.flutterwaveCollection.upsert({
            where: { flwTransactionId: id },
            create: { flwTransactionId: id, outcome: CollectionOutcome.UNVERIFIED, firstSource: 'SWEEP' },
            update: {},
          });
          if (SETTLED_OUTCOMES.includes(row.outcome)) continue;
          await this.payIn.enqueue(id, 'SWEEP');
          queued++;
        }
      }
      if (queued > 0) this.log.log(`Sweep queued ${queued} payment(s) from ${pages} page(s)`);
      if (totalPages > MAX_PAGES) {
        const error = `Stopped at the ${MAX_PAGES}-page limit of ${totalPages} pages`;
        this.log.warn(error);
        return { status: 'PARTIAL', pages, seen, queued, error };
      }
      return { status: 'OK', pages, seen, queued, error: null };
    } catch (err) {
      const error = redactIds((err as Error).message);
      this.log.warn(`Sweep stopped after ${pages} page(s): ${error}`);
      if (err instanceof FlutterwaveError && err.kind === 'CONFIG') {
        await this.alerts.raise(AlertType.FLUTTERWAVE_CONFIG, 'config', 'Flutterwave refused the missed-webhook sweep', [error]);
      }
      return { status: 'PARTIAL', pages, seen, queued, error };
    }
  }

  async recheck(now = new Date()): Promise<{ queued: number }> {
    const stale = new Date(now.getTime() - 10 * MINUTE);
    const rows = await this.prisma.flutterwaveCollection.findMany({
      where: {
        outcome: { in: [CollectionOutcome.UNVERIFIED, CollectionOutcome.PENDING_PROVIDER] },
        firstSeenAt: { gte: new Date(now.getTime() - 8 * DAY) },
        OR: [{ lastCheckedAt: null, firstSeenAt: { lt: stale } }, { lastCheckedAt: { lt: stale } }],
      },
      orderBy: { firstSeenAt: 'asc' },
      take: 200,
    });
    for (const row of rows) await this.payIn.enqueue(row.flwTransactionId, 'RECHECK');
    if (rows.length > 0) this.log.log(`Re-check queued ${rows.length} payment(s)`);
    return { queued: rows.length };
  }

  /** No account, and no attempt at one: nothing can have been paid in. */
  private async railInUse(): Promise<boolean> {
    if ((await this.prisma.virtualAccount.count()) > 0) return true;
    return (await this.prisma.virtualAccountRequest.count()) > 0;
  }
}
