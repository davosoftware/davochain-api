import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { UserOtpPurpose } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { UserOtpService } from '../auth/user-otp.service';
import { recordFailedLogin } from '../auth/failed-logins';
import { TemplatedMailService } from '../cms/templated-mail.service';
import { formatLagos } from '../common/dates';
import { PIN_LOCK_MINUTES, PIN_MAX_TRIES, checkNewPin } from './pin-rules';

export interface PinStatus {
  isSet: boolean;
  setAt: Date | null;
  /** Set while five wrong PINs keep it locked. */
  lockedUntil: Date | null;
  triesLeft: number;
}

/**
 * The 4-digit transaction PIN (29 Oct 2026). Asked for before money leaves the
 * wallet or a swap runs, so a phone left unlocked, or a stolen session, cannot
 * empty a wallet.
 *
 * Stored with scrypt like a password. Four digits are only 10,000 PINs, so the
 * real defence is the counter: five wrong in a row lock it for 30 minutes.
 */
@Injectable()
export class TransactionPinService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly otps: UserOtpService,
    private readonly mail: TemplatedMailService,
  ) {}

  async status(userId: string, now = new Date()): Promise<PinStatus> {
    const u = await this.load(userId);
    const locked = u.pinLockedUntil && u.pinLockedUntil > now ? u.pinLockedUntil : null;
    return {
      isSet: !!u.transactionPinHash,
      setAt: u.transactionPinSetAt,
      lockedUntil: locked,
      triesLeft: locked ? 0 : Math.max(0, PIN_MAX_TRIES - u.pinFailedCount),
    };
  }

  /** First PIN. The password too, so whoever holds an unlocked phone cannot make one and send. */
  async create(userId: string, password: string, pin: string): Promise<PinStatus> {
    this.assertUsable(pin);
    const u = await this.confirmPassword(userId, password);
    if (u.transactionPinHash) throw this.alreadySet();
    const hash = await this.passwords.hash(pin);
    const done = await this.prisma.user.updateMany({
      where: { id: userId, transactionPinHash: null },
      data: { transactionPinHash: hash, transactionPinSetAt: new Date(), pinFailedCount: 0, pinLockedUntil: null },
    });
    if (done.count !== 1) throw this.alreadySet();
    await this.announce(u, 'created');
    return this.status(userId);
  }

  /** The old PIN, then the new one. A wrong old PIN counts toward the lock. */
  async change(userId: string, currentPin: string, newPin: string): Promise<PinStatus> {
    this.assertUsable(newPin);
    await this.verify(userId, currentPin);
    if (currentPin === newPin) throw new BadRequestException({ code: 'PIN_SAME', message: 'Your new PIN must be different from the old one.' });
    const u = await this.load(userId);
    await this.prisma.user.update({
      where: { id: userId },
      data: { transactionPinHash: await this.passwords.hash(newPin), transactionPinSetAt: new Date(), pinFailedCount: 0, pinLockedUntil: null },
    });
    await this.announce(u, 'changed with your old PIN');
    return this.status(userId);
  }

  /** Forgot PIN, step 1: the password, then a 6-digit code goes to their email. */
  async requestReset(userId: string, password: string): Promise<{ sent: true }> {
    await this.confirmPassword(userId, password);
    await this.otps.requestForUser(userId, UserOtpPurpose.PIN_RESET);
    return { sent: true };
  }

  /**
   * Forgot PIN, step 2: the code and the new PIN. Also unlocks a locked PIN.
   * Sends and withdrawals then wait as after a password change (the level's
   * cool-off), because a thief with the phone and the inbox could otherwise
   * reset and send at once. Swaps keep working: the money stays in the wallet.
   */
  async reset(userId: string, code: string, newPin: string): Promise<PinStatus> {
    this.assertUsable(newPin);
    const u = await this.load(userId);
    if (!u.transactionPinHash) throw this.notSet();
    await this.otps.consume(userId, code, UserOtpPurpose.PIN_RESET);
    const now = new Date();
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        transactionPinHash: await this.passwords.hash(newPin),
        transactionPinSetAt: now,
        pinFailedCount: 0,
        pinLockedUntil: null,
        credentialsChangedAt: now,
      },
    });
    await this.announce(u, 'reset with a code sent to your email');
    return this.status(userId);
  }

  /**
   * The check in front of every money action. Throws 403 with a `code` the app
   * acts on: PIN_NOT_SET, PIN_REQUIRED, PIN_WRONG (with triesLeft) or
   * PIN_LOCKED (with until). Never 401: the app reads 401 as "sign in again".
   */
  async verify(userId: string, pin: string | undefined, now = new Date()): Promise<void> {
    const u = await this.load(userId);
    if (!u.transactionPinHash) throw this.notSet();
    if (!pin) throw new ForbiddenException({ code: 'PIN_REQUIRED', message: 'Enter your transaction PIN.' });
    if (u.pinLockedUntil && u.pinLockedUntil > now) throw this.locked(u.pinLockedUntil);

    // Take a try BEFORE checking, in one UPDATE: parallel guesses cannot all
    // see "no tries used" and get more than five in.
    const slot = await this.prisma.user.updateMany({
      where: {
        id: userId,
        pinFailedCount: { lt: PIN_MAX_TRIES },
        OR: [{ pinLockedUntil: null }, { pinLockedUntil: { lte: now } }],
      },
      data: { pinFailedCount: { increment: 1 } },
    });
    if (slot.count === 0) {
      const again = await this.load(userId);
      throw this.locked(again.pinLockedUntil && again.pinLockedUntil > now ? again.pinLockedUntil : new Date(now.getTime() + PIN_LOCK_MINUTES * 60_000));
    }

    const right = /^[0-9]+$/.test(pin) && (await this.passwords.verify(pin, u.transactionPinHash));
    if (right) {
      await this.prisma.user.update({ where: { id: userId }, data: { pinFailedCount: 0, pinLockedUntil: null } });
      return;
    }

    const after = await this.load(userId);
    const left = PIN_MAX_TRIES - after.pinFailedCount;
    if (left > 0) {
      throw new ForbiddenException({
        code: 'PIN_WRONG',
        triesLeft: left,
        message: `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
      });
    }
    const until = new Date(now.getTime() + PIN_LOCK_MINUTES * 60_000);
    // Only the request that locks it sends the email.
    const lockedNow = await this.prisma.user.updateMany({
      where: { id: userId, pinFailedCount: { gte: PIN_MAX_TRIES }, OR: [{ pinLockedUntil: null }, { pinLockedUntil: { lte: now } }] },
      data: { pinLockedUntil: until, pinFailedCount: 0 },
    });
    if (lockedNow.count === 1) {
      await this.mail.send({
        key: 'user.pin_locked',
        to: u.email,
        variables: { firstName: u.firstName, lastName: u.lastName, email: u.email, until: formatLagos(until) },
      });
    }
    throw this.locked(until);
  }

  /** People → Users: an owner unlocks a locked PIN for a customer who called support. */
  async unlockByAdmin(userId: string): Promise<{ before: { pinLockedUntil: Date | null; pinFailedCount: number } }> {
    const u = await this.load(userId);
    await this.prisma.user.update({ where: { id: userId }, data: { pinFailedCount: 0, pinLockedUntil: null } });
    return { before: { pinLockedUntil: u.pinLockedUntil, pinFailedCount: u.pinFailedCount } };
  }

  private async load(userId: string) {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        passwordHash: true,
        lockedUntil: true,
        transactionPinHash: true,
        transactionPinSetAt: true,
        pinFailedCount: true,
        pinLockedUntil: true,
      },
    });
    if (!u) throw new NotFoundException('User not found');
    return u;
  }

  private async confirmPassword(userId: string, password: string) {
    const u = await this.load(userId);
    if (u.lockedUntil && u.lockedUntil > new Date()) {
      throw new ForbiddenException(`Too many failed attempts. Try again after ${u.lockedUntil.toISOString()}`);
    }
    if (!password || !(await this.passwords.verify(password, u.passwordHash))) {
      await recordFailedLogin(this.prisma, 'users', userId);
      throw new ForbiddenException({ code: 'PASSWORD_WRONG', message: 'Incorrect password' });
    }
    return u;
  }

  private assertUsable(pin: string): void {
    const reason = checkNewPin(pin);
    if (reason) throw new BadRequestException({ code: 'PIN_WEAK', message: reason });
  }

  /** Security notice, every time: how someone whose phone was taken finds out. */
  private async announce(u: { email: string; firstName: string; lastName: string }, method: string): Promise<void> {
    await this.mail.send({
      key: 'user.pin_changed',
      to: u.email,
      variables: { firstName: u.firstName, lastName: u.lastName, email: u.email, changedAt: formatLagos(new Date()), method },
    });
  }

  private notSet() {
    return new ForbiddenException({ code: 'PIN_NOT_SET', message: 'Create a transaction PIN first.' });
  }

  private alreadySet() {
    return new ConflictException({ code: 'PIN_ALREADY_SET', message: 'You already have a transaction PIN. Change it or reset it instead.' });
  }

  private locked(until: Date) {
    return new ForbiddenException({
      code: 'PIN_LOCKED',
      until: until.toISOString(),
      message: `Too many wrong PINs. Try again after ${formatLagos(until)}, or reset your PIN.`,
    });
  }
}
