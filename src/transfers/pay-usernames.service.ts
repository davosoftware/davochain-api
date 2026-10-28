import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PolicyLevel, Prisma, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { levelOf } from '../levels/levels';
import { lagosWhen } from '../common/dates';
import { NotificationsService } from '../notifications/notifications.service';
import { checkPayUsername, displayName } from './pay-username';

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
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

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
  async lookup(callerId: string, raw: string): Promise<{ username: string; displayName: string; canReceive: boolean; reason: string | null }> {
    const user = await this.find(raw);
    const base = { username: user.payUsername!, displayName: displayName(user) };
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
      select: { id: true, firstName: true, lastName: true, status: true, kycTier: true, payUsername: true },
    });
    if (!user || user.status === UserStatus.CLOSED) throw notFound();
    return user;
  }

  /**
   * People → Users: an admin takes away an offensive name. Held for 30 days
   * like any name given up; the customer is told why and can choose another.
   */
  async removeByAdmin(userId: string, reason: string): Promise<{ before: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, payUsername: true } });
    if (!user?.payUsername) throw new NotFoundException('This customer has no payment username.');
    const before = user.payUsername;
    await this.prisma.$transaction(async (t) => {
      await holdPayUsername(t, userId, before);
      await t.user.update({ where: { id: userId }, data: { payUsername: null, payUsernameSetAt: null } });
    });
    await this.notifications?.notify({
      userId,
      type: 'account.pay_username_removed',
      title: 'Your payment username was removed',
      body: `We removed @${before}: ${reason}. Please choose a new username.`,
    });
    return { before };
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
