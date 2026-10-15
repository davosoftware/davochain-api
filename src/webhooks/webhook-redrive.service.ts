import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AlertType } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { JobLeaseService } from '../common/job-lease.service';
import { JOBS, QUEUES, jobId } from '../common/queues';

const MINUTE = 60_000;
/** Give the normal path (queue + BullMQ retries) a head start before re-driving. */
const SETTLE_MS = 2 * MINUTE;
/** A poison event is not re-driven for ever; past this it waits for a person. */
const MAX_ATTEMPTS = 20;
const BATCH = 100;
const BACKLOG_ALERT_MS = 30 * MINUTE;

/**
 * The outbox half of webhook intake (PROJECT_REVIEW H5).
 *
 * A genuine Quidax event is stored before it is acknowledged; processedAt is
 * set only once it has been handled. So "stored, genuine, processedAt null"
 * is exactly the list of events still to do, whatever went wrong: Redis down
 * at arrival, a queue entry lost, or BullMQ giving up after its retries.
 * Every handler is safe to run twice (C2, H6), so re-driving is safe.
 */
@Injectable()
export class WebhookRedriveService {
  private readonly log = new Logger(WebhookRedriveService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.WEBHOOKS) private readonly queue: Queue,
    private readonly alerts: OpsAlertsService,
    private readonly leases: JobLeaseService,
  ) {}

  @Cron('*/5 * * * *', { name: 'quidax-webhook-redrive' })
  async cron(): Promise<void> {
    try {
      await this.leases.run('quidax-webhook-redrive', 4 * MINUTE, () => this.redrive());
    } catch (err) {
      this.log.error(`Webhook re-drive failed: ${(err as Error).message}`);
    }
  }

  async redrive(): Promise<number> {
    const now = Date.now();
    const waiting = await this.prisma.webhookEvent.findMany({
      where: {
        signatureValid: true,
        processedAt: null,
        attempts: { lt: MAX_ATTEMPTS },
        receivedAt: { lt: new Date(now - SETTLE_MS) },
      },
      orderBy: { receivedAt: 'asc' },
      select: { id: true, receivedAt: true },
      take: BATCH,
    });

    // A fresh job id per five-minute window: BullMQ ignores an add whose id it
    // still holds, including a job it already gave up on.
    const window = Math.floor(now / (5 * MINUTE));
    for (const event of waiting) {
      await this.queue.add(
        JOBS.PROCESS_WEBHOOK,
        { webhookEventId: event.id },
        { jobId: jobId('wh', event.id, 'redrive', window) },
      );
    }
    if (waiting.length > 0) this.log.warn(`Re-queued ${waiting.length} unprocessed Quidax webhook event(s)`);

    const oldest = await this.prisma.webhookEvent.findFirst({
      where: { signatureValid: true, processedAt: null },
      orderBy: { receivedAt: 'asc' },
      select: { receivedAt: true },
    });
    if (oldest && now - oldest.receivedAt.getTime() > BACKLOG_ALERT_MS) {
      const minutes = Math.round((now - oldest.receivedAt.getTime()) / MINUTE);
      await this.alerts.raise(
        AlertType.RECONCILIATION_DRIFT,
        'quidax-webhook-backlog',
        'Quidax webhook events are not being processed',
        [
          `The oldest unprocessed Quidax event has waited ${minutes} minutes.`,
          'Deposits, withdrawals or swaps may be waiting on it. Check the worker, Redis and the webhook_events table (processedAt is empty, lastError says why).',
        ],
      );
    }
    return waiting.length;
  }
}
