import { avatarUrl } from '../avatars/avatars.service';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { PolicyLevel, Prisma, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { levelOf } from '../levels/levels';
import { lagosWhen } from '../common/dates';
import { NotificationsService } from '../notifications/notifications.service';
import { checkPayUsername, displayName, generatePayUsername } from './pay-username';

const DAY = 24 * 60 * 60 * 1000;
/** How long an old name is kept from everyone else, and how often a name can change. */
export const PAY_USERNAME_HOLD_DAYS = 30;

/**
 * Keep a name someone gave up from everyone else for 30 days. Shared with
 * account closure, which runs it inside its own transaction.
 */
export async function holdPayUsername(t: Prisma.TransactionClient, userId: string, username: string, from = new Date()): Promise<void> {
  const heldUntil = new Date(from.getTime() + PAY_USERNAME_HOLD_DAYS * DAY);
  await t.payUsernameHold.upsert({
    where: { username },
    create: { username, userId, heldUntil },
    update: { userId, heldUntil },
  });
}

const notFound = () =>
  new NotFoundException({ code: 'USERNAME_NOT_FOUND', message: 'No DavoChain customer has that username. Check the spelling.' });

/**
 * Payment usernames (decisions 28 Oct 2026): chosen by the customer, unique
 * whatever the capitals, changeable once every 30 days. A name given up is
 * held for 30 days so nobody can take it over and receive coins meant for its
 * old owner.
 */
@Injectable()
export class PayUsernamesService {
  private readonly log = new Logger(PayUsernamesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /**
   * GET /v1/me/pay-username. `chosenByYou` is false for the name made at
   * sign-up, which can be changed at once; after a change, `canChangeFrom`
   * says when the next one is allowed.
   */
  async mine(userId: string): Promise<{ payUsername: string | null; chosenByYou: boolean; canChangeFrom: string | null }> {
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, payUsername: true, payUsernameSetAt: true } });
    if (!me) throw new NotFoundException('User not found');
    const next = me.payUsernameSetAt ? new Date(me.payUsernameSetAt.getTime() + PAY_USERNAME_HOLD_DAYS * DAY) : null;
    return {
      payUsername: me.payUsername,
      chosenByYou: me.payUsernameSetAt !== null,
      canChangeFrom: next && next > new Date() ? next.toISOString() : null,
    };
  }

  /**
   * Give a customer without a payment username a generated one,
   * "firstname_1234" (decision 28 Oct 2026): at sign-up, and by the backfill
   * for everyone who signed up before. `payUsernameSetAt` stays null: the
   * customer never chose it, so they may change it straight away. Closed and
   * deleted accounts get none. Returns the name, or null.
   */
  async assignGenerated(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, firstName: true, payUsername: true, status: true, dataDeletedAt: true },
    });
    if (!user || user.status === UserStatus.CLOSED || user.dataDeletedAt) return null;
    if (user.payUsername) return user.payUsername;

    for (let attempt = 0; attempt < 12; attempt++) {
      // 4 digits make 10,000 names per first name; after a few clashes, more.
      const name = generatePayUsername(user.firstName, undefined, attempt < 4 ? 4 : attempt < 8 ? 6 : 8);
      if (!(await this.isFree(userId, name))) continue;
      try {
        const { count } = await this.prisma.user.updateMany({
          where: { id: userId, payUsername: null },
          data: { payUsername: name, payUsernameSetAt: null },
        });
        if (count === 1) return name;
        // Given one in the meantime (a double sign-up, the backfill racing): keep that.
        return (await this.prisma.user.findUnique({ where: { id: userId }, select: { payUsername: true } }))?.payUsername ?? null;
      } catch (err) {
        // Someone took this exact name a moment ago: try another.
        if ((err as { code?: string }).code !== 'P2002') throw err;
      }
    }
    throw new Error(`Could not find a free payment username for ${userId}`);
  }

  /**
   * Every open account without a payment username gets one: the customers
   * who signed up before 28 Oct 2026, and anyone whose name was removed or
   * whose sign-up step failed. Run at start-up and hourly. Returns how many.
   */
  async backfill(): Promise<number> {
    let done = 0;
    for (;;) {
      const page = await this.prisma.user.findMany({
        where: { payUsername: null, status: { not: UserStatus.CLOSED }, dataDeletedAt: null },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: 200,
      });
      if (!page.length) return done;
      let progressed = 0;
      for (const u of page) {
        try {
          if (await this.assignGenerated(u.id)) {
            done++;
            progressed++;
          }
        } catch (err) {
          this.log.error(`Payment username for ${u.id}: ${(err as Error).message}`);
        }
      }
      // A page where nothing could be given out would come back forever.
      if (!progressed) return done;
    }
  }

  /** PUT /v1/me/pay-username */
  async set(userId: string, raw: string): Promise<{ payUsername: string }> {
    const verdict = checkPayUsername(raw);
    if (!verdict.ok) throw new BadRequestException({ code: 'USERNAME_INVALID', message: verdict.reason });
    const name = verdict.value;

    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, payUsername: true, payUsernameSetAt: true } });
    if (!me) throw new NotFoundException('User not found');
    if (me.payUsername === name) return { payUsername: name };

    if (me.payUsername && me.payUsernameSetAt) {
      const next = new Date(me.payUsernameSetAt.getTime() + PAY_USERNAME_HOLD_DAYS * DAY);
      if (next > new Date()) {
        throw new BadRequestException({
          code: 'USERNAME_CHANGE_TOO_SOON',
          until: next.toISOString(),
          message: `You can change your username again from ${lagosWhen(next)}.`,
        });
      }
    }
    await this.assertFree(userId, name);

    const now = new Date();
    try {
      await this.prisma.$transaction(async (t) => {
        if (me.payUsername) await holdPayUsername(t, userId, me.payUsername, now);
        await t.payUsernameHold.deleteMany({ where: { username: name } });
        await t.user.update({ where: { id: userId }, data: { payUsername: name, payUsernameSetAt: now } });
      });
    } catch (err) {
      // Two people choosing the same name at the same moment: the unique index decides.
      if ((err as { code?: string }).code === 'P2002') throw this.taken();
      throw err;
    }
    return { payUsername: name };
  }

  /** GET /v1/me/pay-username/check: whether a name can be chosen, before saving it. */
  async check(userId: string, raw: string): Promise<{ username: string; available: boolean; reason: string | null }> {
    const verdict = checkPayUsername(raw);
    if (!verdict.ok) return { username: verdict.value, available: false, reason: verdict.reason ?? null };
    try {
      await this.assertFree(userId, verdict.value);
      return { username: verdict.value, available: true, reason: null };
    } catch (err) {
      if (err instanceof ConflictException) return { username: verdict.value, available: false, reason: 'That username is taken.' };
      throw err;
    }
  }

  /**
   * GET /v1/transfers/recipient: the short name behind a username, so the
   * sender can check before confirming. A closed account reads as unknown.
   */
  async lookup(
    callerId: string,
    raw: string,
  ): Promise<{ username: string; displayName: string; avatarUrl: string | null; canReceive: boolean; reason: string | null }> {
    const user = await this.find(raw);
    // The photo (29 Oct 2026) helps the sender see it is the right person.
    const base = { username: user.payUsername!, displayName: displayName(user), avatarUrl: avatarUrl(user.avatarId) };
    if (user.id === callerId) return { ...base, canReceive: false, reason: 'This is your own username.' };
    if (user.status !== UserStatus.ACTIVE) return { ...base, canReceive: false, reason: 'This DavoChain account cannot receive coins right now.' };
    if (levelOf(user.kycTier) === PolicyLevel.NONE) {
      return { ...base, canReceive: false, reason: 'They have not finished Basic verification yet, so they cannot receive coins.' };
    }
    return { ...base, canReceive: true, reason: null };
  }

  /** The customer behind a username, or 404 USERNAME_NOT_FOUND. Closed accounts are not found. */
  async find(raw: string) {
    const verdict = checkPayUsername(raw);
    if (!verdict.value) throw notFound();
    const user = await this.prisma.user.findUnique({
      where: { payUsername: verdict.value },
      select: { id: true, firstName: true, lastName: true, status: true, kycTier: true, payUsername: true, avatarId: true },
    });
    if (!user || user.status === UserStatus.CLOSED) throw notFound();
    return user;
  }

  /**
   * People → Users: an admin takes away an offensive name. Held for 30 days
   * like any name given up; the customer is told why and can choose another.
   */
  async removeByAdmin(userId: string, reason: string): Promise<{ before: string; after: string | null }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, payUsername: true } });
    if (!user?.payUsername) throw new NotFoundException('This customer has no payment username.');
    const before = user.payUsername;
    await this.prisma.$transaction(async (t) => {
      await holdPayUsername(t, userId, before);
      await t.user.update({ where: { id: userId }, data: { payUsername: null, payUsernameSetAt: null } });
    });
    // Everyone has a name (decision 28 Oct 2026): a new generated one at once.
    const after = await this.assignGenerated(userId).catch(() => null);
    await this.notifications?.notify({
      userId,
      type: 'account.pay_username_removed',
      title: 'Your payment username was changed',
      body: after
        ? `We removed @${before}: ${reason}. Your username is now @${after}. You can choose another one.`
        : `We removed @${before}: ${reason}. Please choose a new username.`,
    });
    return { before, after };
  }

  private async isFree(userId: string, name: string): Promise<boolean> {
    try {
      await this.assertFree(userId, name);
      return true;
    } catch (err) {
      if (err instanceof ConflictException) return false;
      throw err;
    }
  }

  private async assertFree(userId: string, name: string): Promise<void> {
    const [owner, hold] = await Promise.all([
      this.prisma.user.findUnique({ where: { payUsername: name }, select: { id: true } }),
      this.prisma.payUsernameHold.findUnique({ where: { username: name } }),
    ]);
    if (owner && owner.id !== userId) throw this.taken();
    if (hold && hold.userId !== userId && hold.heldUntil > new Date()) throw this.taken();
  }

  private taken() {
    return new ConflictException({ code: 'USERNAME_TAKEN', message: 'That username is taken. Please choose another.' });
  }
}
