import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { BroadcastAudience, NotificationChannel, Prisma, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TemplatedMailService } from '../cms/templated-mail.service';
import { dec, str, ZERO } from '../common/money';
import { JOBS, QUEUES, jobId } from '../common/queues';

export interface UserListRow {
  /** 1 is the most recent sign-up. Continues across pages. */
  serial: number;
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  status: UserStatus;
  kycTier: string;
  kycStatus: string;
  isTest: boolean;
  walletReady: boolean;
  suspendedReason: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
}

@Injectable()
export class UsersAdminService {
  private readonly log = new Logger(UsersAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.NOTIFICATIONS) private readonly queue: Queue,
    private readonly mail: TemplatedMailService,
  ) {}

  /**
   * The number the first row of this page carries.
   *
   * Counts everyone who sorts ahead of the cursor under the same ordering the
   * query uses — newer first, id breaking ties — so the numbering matches the
   * rows that actually come back rather than approximating them.
   */
  private async serialOf(
    cursor: string | undefined,
    where: Prisma.UserWhereInput,
  ): Promise<number> {
    if (!cursor) return 1;

    const at = await this.prisma.user.findUnique({
      where: { id: cursor },
      select: { createdAt: true, id: true },
    });
    if (!at) return 1;

    const ahead = await this.prisma.user.count({
      where: {
        AND: [
          where,
          {
            OR: [
              { createdAt: { gt: at.createdAt } },
              { createdAt: at.createdAt, id: { gt: at.id } },
            ],
          },
        ],
      },
    });

    // +1 for the cursor row itself, +1 because the numbering starts at one.
    return ahead + 2;
  }

  /**
   * The list is deliberately cheap — no balances, no wallet joins. Balances are
   * fetched only when a row is expanded, so opening the page does not cost one
   * query per user.
   */
  async list(params: {
    search?: string;
    status?: UserStatus;
    limit?: number;
    cursor?: string;
  }): Promise<{ rows: UserListRow[]; nextCursor: string | null; total: number }> {
    const limit = Math.min(params.limit ?? 50, 200);
    const search = params.search?.trim();

    const where: Prisma.UserWhereInput = {
      ...(params.status ? { status: params.status } : {}),
      ...(search
        ? {
            OR: [
              { email: { contains: search, mode: 'insensitive' } },
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search } },
            ],
          }
        : {}),
    };

    /*
     * Where this page starts in the numbering.
     *
     * The newest sign-up is 1, so a row's number is how many people registered
     * after it, plus one. Counted rather than derived from the page index,
     * because with a cursor the client has no idea how many rows came before.
     */
    const startAt = await this.serialOf(params.cursor, where);

    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        // id breaks ties. Ordering by a timestamp alone is not a total order,
        // and a cursor over a non-total order can repeat or skip rows when two
        // people register in the same millisecond.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          status: true,
          kycTier: true,
          kycStatus: true,
          isTest: true,
          suspendedReason: true,
          createdAt: true,
          lastLoginAt: true,
          quidaxAccount: { select: { id: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      rows: page.map((u, i) => ({
        serial: startAt + i,
        id: u.id,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        phone: u.phone,
        status: u.status,
        kycTier: u.kycTier,
        kycStatus: u.kycStatus,
        isTest: u.isTest,
        walletReady: Boolean(u.quidaxAccount),
        suspendedReason: u.suspendedReason,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
      total,
    };
  }

  /** Everything about one user, including balances. Loaded on expand. */
  async detail(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        quidaxAccount: { select: { quidaxUserId: true, quidaxSn: true, aliasEmail: true } },
        kycProfile: {
          select: {
            tier: true,
            status: true,
            bvnLast4: true,
            ninLast4: true,
            submittedAt: true,
            reviewedAt: true,
            rejectionReason: true,
          },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');

    const [balances, assets, txCount] = await Promise.all([
      this.prisma.balance.findMany({ where: { userId } }),
      this.prisma.asset.findMany({
        where: { isListed: true },
        orderBy: { sortOrder: 'asc' },
        select: { code: true, name: true, displayScale: true, isFiat: true },
      }),
      this.prisma.transaction.count({ where: { userId } }),
    ]);

    const byAsset = new Map(balances.map((b) => [b.assetCode, b]));

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      status: user.status,
      isTest: user.isTest,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      suspendedAt: user.suspendedAt,
      suspendedReason: user.suspendedReason,
      suspendedBy: user.suspendedBy,
      transactionCount: txCount,
      quidax: user.quidaxAccount,
      kyc: user.kycProfile,
      // Only coins they actually hold — a list of fifteen zeroes is noise.
      balances: assets
        .map((a) => {
          const row = byAsset.get(a.code);
          const available = dec(row?.available ?? 0);
          const locked = dec(row?.locked ?? 0);
          return {
            asset: a.code,
            name: a.name,
            isFiat: a.isFiat,
            available: str(available, a.displayScale),
            locked: str(locked, a.displayScale),
            total: str(available.plus(locked), a.displayScale),
            isZero: available.plus(locked).isZero(),
          };
        })
        .filter((b) => !b.isZero),
    };
  }

  /**
   * Suspending revokes every session immediately. Leaving the access token
   * alive would let a suspended user keep trading for up to fifteen minutes,
   * which is exactly the window you suspended them to close.
   */
  async suspend(adminId: string, userId: string, reason: string) {
    if (!reason?.trim()) {
      throw new BadRequestException('A reason is required — the user is shown it when they sign in');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.status === UserStatus.SUSPENDED) return this.detail(userId);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          status: UserStatus.SUSPENDED,
          suspendedAt: new Date(),
          suspendedReason: reason.trim(),
          suspendedBy: adminId,
        },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    // Their sessions are already revoked, so the app cannot tell them. Email is
    // the only channel left that reaches a suspended account.
    await this.mail.send({
      key: 'user.suspended',
      to: user.email,
      variables: {
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        reason: reason.trim(),
      },
    });

    this.log.warn(`User ${userId} suspended by ${adminId}: ${reason.trim()}`);
    return this.detail(userId);
  }

  async reinstate(adminId: string, userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        status: UserStatus.ACTIVE,
        suspendedAt: null,
        suspendedReason: null,
        suspendedBy: null,
      },
    });

    // Only worth an email if they were actually locked out. Reinstating an
    // active account is a no-op, and telling somebody their suspension is over
    // when they never had one is alarming.
    if (user.status === UserStatus.SUSPENDED) {
      await this.mail.send({
        key: 'user.reinstated',
        to: user.email,
        variables: {
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
        },
      });
    }

    this.log.warn(`User ${userId} reinstated by ${adminId}`);
    return this.detail(userId);
  }

  // ── broadcasts ──────────────────────────────────────────────

  /**
   * Send an in-app message to everyone, or to a chosen set.
   *
   * Written straight into the notifications table, so it lands in the same feed
   * as a deposit or trade alert and needs no separate delivery path. A push
   * provider, when one exists, reads from the same rows.
   */
  async broadcast(params: {
    adminId: string;
    title: string;
    body: string;
    userIds?: string[];
  }) {
    const title = params.title?.trim();
    const body = params.body?.trim();
    if (!title) throw new BadRequestException('A title is required');
    if (!body) throw new BadRequestException('A message is required');

    const selected = params.userIds?.filter(Boolean) ?? [];
    const audience = selected.length > 0 ? BroadcastAudience.SELECTED : BroadcastAudience.ALL;

    const recipients = await this.prisma.user.findMany({
      where:
        audience === BroadcastAudience.SELECTED
          ? { id: { in: selected } }
          : // Never message suspended or closed accounts — they cannot act on it.
            { status: UserStatus.ACTIVE },
      select: { id: true },
    });

    if (recipients.length === 0) {
      throw new BadRequestException('No matching recipients');
    }

    const broadcast = await this.prisma.broadcast.create({
      data: {
        title,
        body,
        audience,
        recipientCount: recipients.length,
        sentBy: params.adminId,
      },
    });

    // One row per recipient per channel. createMany in chunks so a large send
    // does not build one enormous statement.
    const CHUNK = 500;
    for (let i = 0; i < recipients.length; i += CHUNK) {
      const slice = recipients.slice(i, i + CHUNK);
      await this.prisma.notification.createMany({
        data: slice.flatMap((r) => [
          {
            userId: r.id,
            broadcastId: broadcast.id,
            type: `admin.broadcast.${broadcast.id}`,
            title,
            body,
            channel: NotificationChannel.IN_APP,
          },
          {
            userId: r.id,
            broadcastId: broadcast.id,
            type: `admin.broadcast.${broadcast.id}`,
            title,
            body,
            channel: NotificationChannel.PUSH,
          },
        ]),
        skipDuplicates: true,
      });
    }

    // createMany cannot return ids, so read the PUSH rows back and queue them.
    // Without this a broadcast reaches the in-app feed and nothing else — the
    // rows sit unsent forever and no device ever hears about it.
    const pushRows = await this.prisma.notification.findMany({
      where: { broadcastId: broadcast.id, channel: NotificationChannel.PUSH, sentAt: null },
      select: { id: true },
    });

    if (pushRows.length > 0) {
      // addBulk in one call: a broadcast to 10,000 users is 10,000 jobs, and
      // adding them one at a time would hold the request open for minutes.
      await this.queue
        .addBulk(
          pushRows.map((r) => ({
            name: JOBS.SEND_NOTIFICATION,
            data: { notificationId: r.id },
            opts: { jobId: jobId('push', r.id) },
          })),
        )
        .catch((err: Error) =>
          // The rows are already written, so the feed is correct either way.
          this.log.error(`Broadcast ${broadcast.id}: could not queue push — ${err.message}`),
        );
    }

    this.log.log(
      `Broadcast "${title}" sent to ${recipients.length} user(s) by ${params.adminId}`,
    );

    return {
      id: broadcast.id,
      title,
      audience,
      recipientCount: recipients.length,
      createdAt: broadcast.createdAt,
    };
  }

  async broadcastHistory(limit = 100) {
    const rows = await this.prisma.broadcast.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
    if (rows.length === 0) return [];

    // Two grouped queries rather than one per row. Counting opens inside the
    // map was a round trip per broadcast, so the history page got slower every
    // time somebody sent something.
    const [opens, senders] = await Promise.all([
      this.prisma.notification.groupBy({
        by: ['broadcastId'],
        where: {
          broadcastId: { in: rows.map((b) => b.id) },
          channel: NotificationChannel.IN_APP,
          readAt: { not: null },
        },
        _count: { _all: true },
      }),
      this.prisma.adminUser.findMany({
        where: { id: { in: [...new Set(rows.map((b) => b.sentBy))] } },
        select: { id: true, name: true },
      }),
    ]);

    // How many have actually been opened — the only real measure of a send.
    const readBy = new Map(opens.map((o) => [o.broadcastId, o._count._all]));
    const nameOf = new Map(senders.map((a) => [a.id, a.name]));

    return rows.map((b) => ({
      id: b.id,
      title: b.title,
      body: b.body,
      audience: b.audience,
      recipientCount: b.recipientCount,
      readCount: readBy.get(b.id) ?? 0,
      sentBy: b.sentBy,
      /** The id means nothing on a screen. Admins are never deleted, only
       *  deactivated, so the row still exists and the fallback is unreachable
       *  short of someone editing the table by hand. */
      sentByName: nameOf.get(b.sentBy) ?? 'Unknown',
      createdAt: b.createdAt,
    }));
  }

  /** Headline counts for the users screen. */
  async stats() {
    const [total, active, suspended, verified, withBalance] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { status: UserStatus.ACTIVE } }),
      this.prisma.user.count({ where: { status: UserStatus.SUSPENDED } }),
      this.prisma.user.count({ where: { kycStatus: 'APPROVED' } }),
      this.prisma.balance
        .findMany({ where: { available: { gt: 0 } }, select: { userId: true }, distinct: ['userId'] })
        .then((r) => r.length),
    ]);

    return { total, active, suspended, verified, withBalance };
  }

  static readonly ZERO = ZERO;
}
