import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { BroadcastAudience, BroadcastStatus, NotificationChannel, Prisma, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JOBS, QUEUES } from '../common/queues';
import { TemplatedMailService } from '../cms/templated-mail.service';
import { escapeHtml } from '../cms/email-frame';
import { ServerSettingsService } from '../settings/server-settings.service';
import { PushService } from './push.service';

type Broadcast = Prisma.BroadcastGetPayload<object>;

const OPEN: BroadcastStatus[] = [BroadcastStatus.QUEUED, BroadcastStatus.SENDING, BroadcastStatus.PAUSED];

/**
 * Broadcasts, sent by a background worker in waves (decisions 29 Oct 2026).
 *
 * Send only saves the message and queues one job, so the admin's request
 * never does the heavy part. The worker (BroadcastProcessor) then takes the
 * next N customers each second (N from System → Server settings), writes each
 * an inbox message, pushes to their phones 500 at a time, and, if the admin
 * ticked email, queues an email to each confirmed address; email waves use
 * the slower email speed.
 *
 * Each wave is claimed by moving the cursor in the same transaction that
 * writes the inbox messages, so two workers (or a job re-run after a crash)
 * can never send the same wave twice. A crash after the claim loses the
 * pushes of at most that one wave; the inbox messages are always there.
 */
@Injectable()
export class BroadcastsService {
  private readonly log = new Logger(BroadcastsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
    private readonly mail: TemplatedMailService,
    @InjectQueue(QUEUES.BROADCASTS) private readonly queueOf: Queue,
    private readonly settings: ServerSettingsService,
  ) {}

  /** POST /v1/admin/broadcasts: save and hand to the worker. Answers at once. */
  async queue(params: { adminId: string; title: string; body: string; userIds?: string[]; withEmail?: boolean }) {
    const title = params.title?.trim();
    const body = params.body?.trim();
    if (!title) throw new BadRequestException('A title is required');
    if (!body) throw new BadRequestException('A message is required');

    const userIds = [...new Set(params.userIds?.filter(Boolean) ?? [])];
    const audience = userIds.length ? BroadcastAudience.SELECTED : BroadcastAudience.ALL;
    const createdAt = new Date();
    const recipientCount = await this.prisma.user.count({ where: this.audienceWhere({ audience, userIds, createdAt }) });
    if (!recipientCount) throw new BadRequestException('No matching recipients');

    const b = await this.prisma.broadcast.create({
      data: {
        title, body, audience, userIds, createdAt, recipientCount,
        sentBy: params.adminId,
        status: BroadcastStatus.QUEUED,
        withEmail: params.withEmail === true,
      },
    });
    await this.enqueue(b.id, 'start');
    this.log.log(`Broadcast "${title}" queued for ${recipientCount} customer(s) by ${params.adminId}`);
    return { id: b.id, title, audience, status: b.status, recipientCount, withEmail: b.withEmail, createdAt: b.createdAt };
  }

  /** The worker's job: start it, then one wave a second until it is done, paused or cancelled. */
  async run(id: string): Promise<void> {
    await this.prisma.broadcast.updateMany({
      where: { id, status: BroadcastStatus.QUEUED },
      data: { status: BroadcastStatus.SENDING, startedAt: new Date() },
    });
    for (;;) {
      const started = Date.now();
      if ((await this.runWave(id)) === 'stop') return;
      const rest = 1000 - (Date.now() - started);
      if (rest > 0) await new Promise((r) => setTimeout(r, rest));
    }
  }

  /** One wave. 'stop' when there is nothing more to do. */
  async runWave(id: string): Promise<'continue' | 'stop'> {
    const b = await this.prisma.broadcast.findUnique({ where: { id } });
    if (!b || b.status !== BroadcastStatus.SENDING) return 'stop';

    const size = this.waveSize(b.withEmail);
    const users = await this.prisma.user.findMany({
      where: { ...this.audienceWhere(b), ...(b.cursor ? { id: { ...this.idFilter(b), gt: b.cursor } } : {}) },
      select: { id: true, email: true, firstName: true, emailVerifiedAt: true },
      orderBy: { id: 'asc' },
      take: size,
    });

    if (!users.length) {
      await this.prisma.broadcast.updateMany({
        where: { id, status: BroadcastStatus.SENDING },
        data: { status: BroadcastStatus.DONE, finishedAt: new Date() },
      });
      this.log.log(`Broadcast ${id} done`);
      return 'stop';
    }

    // Claim the wave and write the inbox messages in one go.
    const now = new Date();
    const type = `admin.broadcast.${id}`;
    const claimed = await this.prisma.$transaction(async (t) => {
      const { count } = await t.broadcast.updateMany({
        where: { id, status: BroadcastStatus.SENDING, cursor: b.cursor },
        data: { cursor: users[users.length - 1].id, processedCount: { increment: users.length } },
      });
      if (count !== 1) return false;
      await t.notification.createMany({
        data: users.map((u) => ({ userId: u.id, broadcastId: id, type, title: b.title, body: b.body, channel: NotificationChannel.IN_APP, sentAt: now })),
      });
      return true;
    });
    // Another worker took it, or it was paused or cancelled meanwhile: look again.
    if (!claimed) return 'continue';

    // Push: every phone of every customer in the wave. A failure is counted, never re-sent.
    const devices = await this.prisma.deviceToken.findMany({
      where: { userId: { in: users.map((u) => u.id) }, disabledAt: null },
      select: { token: true },
    });
    const tokens = devices.map((d) => d.token);
    let push = { sent: 0, failed: 0 };
    try {
      push = await this.push.sendToTokens(tokens, { title: b.title, body: b.body, data: { type, broadcastId: id } });
    } catch (err) {
      push = { sent: 0, failed: tokens.length };
      this.log.warn(`Broadcast ${id}: push failed for a wave of ${tokens.length} phone(s): ${(err as Error).message}`);
    }

    // Email: confirmed addresses only, queued for the mail worker.
    let emails = 0;
    if (b.withEmail) {
      // The admin's words are plain text: shown as typed, never run as HTML.
      const message = escapeHtml(b.body).replace(/\r?\n/g, '<br>');
      for (const u of users.filter((x) => x.emailVerifiedAt)) {
        await this.mail.send({ key: 'admin.broadcast', to: u.email, variables: { firstName: u.firstName, title: b.title, message }, dedupeOn: `${id}:${u.id}` });
        emails++;
      }
    }

    await this.prisma.broadcast.update({
      where: { id },
      data: { pushSentCount: { increment: push.sent }, pushFailedCount: { increment: push.failed }, emailQueuedCount: { increment: emails } },
    });
    return 'continue';
  }

  /** GET /v1/admin/broadcasts: the latest broadcasts, with progress. */
  async history(limit = 100) {
    const rows = await this.prisma.broadcast.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(limit, 200) });
    if (!rows.length) return [];
    // Two grouped queries, not one per row.
    const [opens, senders] = await Promise.all([
      this.prisma.notification.groupBy({
        by: ['broadcastId'],
        where: { broadcastId: { in: rows.map((b) => b.id) }, channel: NotificationChannel.IN_APP, readAt: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.adminUser.findMany({ where: { id: { in: [...new Set(rows.map((b) => b.sentBy))] } }, select: { id: true, name: true } }),
    ]);
    const readBy = new Map(opens.map((o) => [o.broadcastId, o._count._all]));
    const nameOf = new Map(senders.map((a) => [a.id, a.name]));
    return rows.map((b) => ({
      id: b.id,
      title: b.title,
      body: b.body,
      audience: b.audience,
      status: b.status,
      withEmail: b.withEmail,
      recipientCount: b.recipientCount,
      processedCount: b.processedCount,
      /** How far along, 0 to 100. */
      percent: b.status === BroadcastStatus.DONE ? 100 : b.recipientCount ? Math.min(100, Math.floor((b.processedCount / b.recipientCount) * 100)) : 0,
      pushSentCount: b.pushSentCount,
      pushFailedCount: b.pushFailedCount,
      emailQueuedCount: b.emailQueuedCount,
      /** Opened in the app's inbox: the only real measure of a send. */
      readCount: readBy.get(b.id) ?? 0,
      sentBy: b.sentBy,
      sentByName: nameOf.get(b.sentBy) ?? 'Unknown',
      createdAt: b.createdAt,
      startedAt: b.startedAt,
      finishedAt: b.finishedAt,
    }));
  }

  async pause(id: string, adminId: string) {
    return this.move(id, adminId, [BroadcastStatus.QUEUED, BroadcastStatus.SENDING], { status: BroadcastStatus.PAUSED }, 'paused');
  }

  async resume(id: string, adminId: string) {
    const r = await this.move(id, adminId, [BroadcastStatus.PAUSED], { status: BroadcastStatus.SENDING }, 'resumed');
    await this.enqueue(id, 'resume');
    return r;
  }

  async cancel(id: string, adminId: string) {
    return this.move(id, adminId, OPEN, { status: BroadcastStatus.CANCELLED, finishedAt: new Date() }, 'cancelled');
  }

  /** After a restart: carry on with anything that was queued or sending. */
  async recover(): Promise<number> {
    const open = await this.prisma.broadcast.findMany({
      where: { status: { in: [BroadcastStatus.QUEUED, BroadcastStatus.SENDING] } },
      select: { id: true },
    });
    for (const b of open) await this.enqueue(b.id, 'recover');
    return open.length;
  }

  private async move(id: string, adminId: string, from: BroadcastStatus[], data: Prisma.BroadcastUpdateManyMutationInput, verb: string) {
    const { count } = await this.prisma.broadcast.updateMany({ where: { id, status: { in: from } }, data: { ...data, controlledBy: adminId } });
    if (count !== 1) {
      const b = await this.prisma.broadcast.findUnique({ where: { id } });
      if (!b) throw new NotFoundException('Broadcast not found');
      throw new BadRequestException(`This broadcast is ${b.status.toLowerCase()}, so it can't be ${verb}.`);
    }
    const b = (await this.prisma.broadcast.findUnique({ where: { id } }))!;
    return { id, status: b.status };
  }

  private async enqueue(id: string, why: string): Promise<void> {
    // A new job id each time: a finished job's id would make BullMQ ignore a resume.
    await this.queueOf.add(JOBS.RUN_BROADCAST, { broadcastId: id }, { jobId: `broadcast-${id}-${why}-${Date.now()}`, attempts: 5, backoff: { type: 'exponential', delay: 5_000 } });
  }

  /** Customers per wave: the push speed, or the slower email speed when email is ticked. */
  private waveSize(withEmail: boolean): number {
    const n = Number(this.settings.get<number>(withEmail ? 'BROADCAST_EMAILS_PER_SECOND' : 'BROADCAST_PER_SECOND'));
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : withEmail ? 10 : 100;
  }

  /**
   * Who it is for. Everyone: active customers who existed when it was sent,
   * so people signing up during a long send don't change its size.
   */
  private audienceWhere(b: Pick<Broadcast, 'audience' | 'userIds' | 'createdAt'>): Prisma.UserWhereInput {
    return b.audience === BroadcastAudience.SELECTED
      ? { id: { in: b.userIds } }
      : { status: UserStatus.ACTIVE, createdAt: { lte: b.createdAt } };
  }

  private idFilter(b: Pick<Broadcast, 'audience' | 'userIds'>): Prisma.StringFilter {
    return b.audience === BroadcastAudience.SELECTED ? { in: b.userIds } : {};
  }
}
