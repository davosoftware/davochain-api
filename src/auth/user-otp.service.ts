import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { UserOtpPurpose, UserStatus } from '@prisma/client';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../common/mail.service';
import { EmailTemplateService } from '../cms/email-template.service';
import { mayLogSecrets } from '../common/dev-secrets';

/** Long enough to read out of an inbox, short enough to be useless later. */
const TTL_MS = 10 * 60_000;

/** Six digits is a million combinations; five guesses makes that a wall. */
const MAX_ATTEMPTS = 5;

/** One code at a time, and not a fresh one every second. */
const RESEND_COOLDOWN_MS = 60_000;

/** Which email each kind of code goes out with. */
const TEMPLATE: Record<UserOtpPurpose, string> = {
  [UserOtpPurpose.PASSWORD_RESET]: 'user.password_reset',
  [UserOtpPurpose.EMAIL_VERIFY]: 'user.email_verify',
};

/**
 * Six-digit codes for customers: password reset for a user who cannot sign in,
 * and (H9) confirming a new customer owns their email address.
 *
 * Mirrors the admin flow, with one deliberate difference: an admin's reset is
 * copied to every owner, because an admin account can move the treasury and the
 * people responsible should see it happen. A user's reset concerns only them.
 */
@Injectable()
export class UserOtpService {
  private readonly log = new Logger(UserOtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly templates: EmailTemplateService,
  ) {}

  /**
   * Plain SHA-256, not scrypt.
   *
   * The usual reason for a slow hash is a low-entropy, long-lived secret. This
   * one is random, six digits, dead in ten minutes and capped at five attempts
   * — the attempt counter is the defence, and a slow hash would only make every
   * legitimate check slower.
   */
  private hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  /**
   * Issue a code.
   *
   * Returns nothing the caller can use to tell whether the email matched an
   * account. That decision is made here and kept here — the route answers the
   * same way either way, because a different answer is a way to find out which
   * addresses are registered.
   */
  async request(email: string, purpose: UserOtpPurpose = UserOtpPurpose.PASSWORD_RESET): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: { id: true, email: true, firstName: true, status: true },
    });
    if (user) await this.send(user, purpose);
  }

  /** H9: the signed-in customer asks for their email code. */
  async requestForUser(userId: string, purpose: UserOtpPurpose): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, firstName: true, status: true },
    });
    if (user) await this.send(user, purpose);
  }

  private async send(user: { id: string; email: string; firstName: string; status: UserStatus }, purpose: UserOtpPurpose): Promise<void> {
    // A suspended or closed account gets no code. Resetting a password would
    // not let them in, and sending one implies it might.
    if (user.status !== UserStatus.ACTIVE) return;

    const recent = await this.prisma.userOtp.findFirst({
      where: { userId: user.id, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (recent && Date.now() - recent.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      // Swallowed rather than thrown: a "wait 40 seconds" error tells whoever
      // asked that this address is real.
      return;
    }

    // Drawn from the CSPRNG, so a code is not guessable from timing or from
    // another one issued a moment earlier.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

    // Supersede anything outstanding: two live codes means a stolen older one
    // still works after somebody asked for a new one.
    await this.prisma.userOtp.updateMany({
      where: { userId: user.id, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    await this.prisma.userOtp.create({
      data: {
        userId: user.id,
        purpose,
        codeHash: this.hash(code),
        expiresAt: new Date(Date.now() + TTL_MS),
      },
    });

    /*
     * Sent through the mailer directly rather than queued.
     *
     * Everywhere else an email is queued so it cannot slow the thing that
     * caused it. Here the code is the entire point of the request, and a queue
     * that is backed up would mean telling somebody to check an inbox nothing
     * has reached yet.
     *
     * `ignoreActive` because a reset code is the only way back into a locked-out
     * account, and a dashboard toggle must not be able to silence it.
     */
    const rendered = await this.templates.render(
      TEMPLATE[purpose],
      {
        firstName: user.firstName,
        email: user.email,
        code,
        expiresIn: `${TTL_MS / 60_000} minutes`,
      },
      { ignoreActive: true },
    );

    const sent = rendered
      ? await this.mail.send({
          to: user.email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          attachments: rendered.attachments,
          templateKey: TEMPLATE[purpose],
        })
      : false;

    if (!sent && mayLogSecrets()) {
      // Without this no reset can be tested until SMTP exists. Guarded on the
      // environment: a production log is not a place for a live code.
      this.log.warn(`SMTP not configured — ${purpose === UserOtpPurpose.EMAIL_VERIFY ? 'email' : 'reset'} code for ${user.email} is ${code}`);
    }
  }

  /**
   * Check a code and burn it.
   *
   * Burnt once the attempts run out whether or not it was right, so six digits
   * can never be walked through.
   */
  async consume(userId: string, code: string, purpose: UserOtpPurpose = UserOtpPurpose.PASSWORD_RESET): Promise<void> {
    const otp = await this.prisma.userOtp.findFirst({
      where: { userId, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw new BadRequestException('That code is not right.');

    if (otp.expiresAt.getTime() <= Date.now()) {
      await this.prisma.userOtp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
      throw new BadRequestException('That code has expired. Ask for a new one.');
    }

    // Take one of the tries BEFORE looking at the code, in a single UPDATE.
    // Reading the count and adding to it later let a burst of parallel
    // requests all see "no tries used" and all get a guess in (C5).
    const slot = await this.prisma.userOtp.updateMany({
      where: { id: otp.id, consumedAt: null, attempts: { lt: MAX_ATTEMPTS }, expiresAt: { gt: new Date() } },
      data: { attempts: { increment: 1 } },
    });
    if (slot.count === 0) {
      await this.prisma.userOtp.updateMany({ where: { id: otp.id, consumedAt: null }, data: { consumedAt: new Date() } });
      throw new BadRequestException('Too many wrong codes. Ask for a new one.');
    }

    const given = Buffer.from(this.hash(code.trim()));
    const expected = Buffer.from(otp.codeHash);
    const matches = given.length === expected.length && timingSafeEqual(given, expected);

    if (!matches) {
      const after = await this.prisma.userOtp.findUnique({ where: { id: otp.id }, select: { attempts: true } });
      const left = MAX_ATTEMPTS - (after?.attempts ?? MAX_ATTEMPTS);
      if (left <= 0) {
        await this.prisma.userOtp.updateMany({ where: { id: otp.id, consumedAt: null }, data: { consumedAt: new Date() } });
      }
      throw new BadRequestException(
        left > 0
          ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
          : 'Too many wrong codes. Ask for a new one.',
      );
    }

    // Single use, even when two right answers arrive together.
    const used = await this.prisma.userOtp.updateMany({
      where: { id: otp.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (used.count !== 1) throw new BadRequestException('That code is not right.');
  }
}
