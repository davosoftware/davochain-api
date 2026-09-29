import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { JOBS, QUEUES, jobId } from '../common/queues';
import { TemplatedMailService } from '../cms/templated-mail.service';

export type NotificationType =
  | 'address.ready'
  | 'deposit.detected'
  | 'deposit.credited'
  | 'deposit.on_hold'
  | 'deposit.failed'
  | 'trade.completed'
  | 'trade.failed'
  | 'withdrawal.submitted'
  | 'withdrawal.sent'
  | 'withdrawal.rejected';

interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  transactionId?: string;
  channels?: NotificationChannel[];

  /**
   * The email that goes with this event, if there is one.
   *
   * Declared at the call site rather than mapped from `type`, because the two
   * do not line up: one `trade.completed` notification is a buy, a sell or a
   * swap depending on the transaction, and each of those is a different email
   * with different figures in it.
   */
  email?: {
    key: string;
    variables?: Record<string, string | null | undefined>;
  };
}

/**
 * Every message is written to the table first and dispatched from there, so the
 * in-app feed and the push are the same record and a failed push can be retried
 * without duplicating the feed entry.
 *
 * Deduplicated on (user, transaction, type, channel) — Quidax re-sends webhooks,
 * and a user who gets "deposit successful" three times stops trusting the app.
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.NOTIFICATIONS) private readonly queue: Queue,
    private readonly mail: TemplatedMailService,
  ) {}

  async notify(input: NotifyInput): Promise<void> {
    const channels = input.channels ?? [NotificationChannel.PUSH, NotificationChannel.IN_APP];

    for (const channel of channels) {
      const row = await this.prisma.notification
        .create({
          data: {
            userId: input.userId,
            transactionId: input.transactionId ?? null,
            type: input.type,
            title: input.title,
            body: input.body,
            channel,
          },
        })
        .catch(() => null); // unique violation = already sent

      // The row is the record; the push is only the delivery. Queue it so a
      // slow or failing FCM can never hold up whatever produced this.
      if (row && channel === NotificationChannel.PUSH) {
        await this.queue
          .add(JOBS.SEND_NOTIFICATION, { notificationId: row.id }, { jobId: jobId('push', row.id) })
          .catch((err: Error) =>
            this.log.error(`Could not queue push for ${row.id}: ${err.message}`),
          );
      }
    }

    if (input.email) await this.email(input);
  }

  /**
   * The email leg.
   *
   * Kept out of the channel loop above because it does not produce a feed row —
   * an email is a copy of the message, not another message. Wrapped so that a
   * missing address or an unreachable mailer can never fail whatever settled
   * the trade that caused it.
   */
  private async email(input: NotifyInput): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: input.userId },
        select: { email: true, firstName: true, lastName: true, isTest: true },
      });
      if (!user?.email) return;

      await this.mail.send({
        key: input.email!.key,
        to: user.email,
        variables: {
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          ...input.email!.variables,
        },
        // Quidax re-sends webhooks. Without this a retried deposit event is a
        // second identical email, and a user who gets three stops reading them.
        dedupeOn: `${input.userId}-${input.transactionId ?? input.type}`,
      });
    } catch (err) {
      this.log.error(`Could not queue ${input.email?.key} for ${input.userId}: ${(err as Error).message}`);
    }
  }

  async feed(userId: string, limit = 50) {
    const [items, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId, channel: NotificationChannel.IN_APP },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 100),
      }),
      this.prisma.notification.count({
        where: { userId, channel: NotificationChannel.IN_APP, readAt: null },
      }),
    ]);

    return {
      unread,
      items: items.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        transactionId: n.transactionId,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
    };
  }

  async markRead(userId: string, ids?: string[]): Promise<number> {
    const { count } = await this.prisma.notification.updateMany({
      where: {
        userId,
        channel: NotificationChannel.IN_APP,
        readAt: null,
        ...(ids?.length ? { id: { in: ids } } : {}),
      },
      data: { readAt: new Date() },
    });
    return count;
  }
}
