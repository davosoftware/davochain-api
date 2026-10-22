import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AdminOtpPurpose, AdminRole, Prisma } from '@prisma/client';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../common/mail.service';
import { EmailTemplateService } from '../cms/email-template.service';
import { mayLogSecrets } from '../common/dev-secrets';

/** Long enough to read out of an inbox, short enough to be useless later. */
const TTL_MS = 10 * 60_000;

/** Six digits is a million combinations; five guesses makes that a wall. */
const MAX_ATTEMPTS = 5;
/**
 * M3: the only answer to a failed admin code, whatever the reason. Unknown
 * emails already got it; anything more specific confirms an admin account.
 */
const NOT_RIGHT = 'That code is not right.';

/** One code at a time, and not a fresh one every second. */
const RESEND_COOLDOWN_MS = 60_000;

/** A code of this kind went out less than a minute ago; that one is still good. */
export class CodeCooldownError extends BadRequestException {
  constructor(readonly waitSeconds: number) {
    super(`A code was just sent. Try again in ${waitSeconds} seconds.`);
  }
}

/** M7: the email each kind of code is sent with. */
const TEMPLATE: Record<AdminOtpPurpose, string> = {
  PASSWORD_RESET: 'admin.password_reset',
  LOGIN: 'admin.login_code',
  TWO_STEP_CHANGE: 'admin.two_step_code',
};

@Injectable()
export class AdminOtpService {
  private readonly log = new Logger(AdminOtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly templates: EmailTemplateService,
  ) {}

  /**
   * Plain SHA-256, not scrypt.
   *
   * The usual reason to use a slow hash is that the secret is low-entropy and
   * long-lived. This one is random, six digits, dead in ten minutes, and capped
   * at five attempts — the attempt counter is the defence, and a slow hash
   * would only make every legitimate check slower.
   */
  private hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  /**
   * Issue a reset code.
   *
   * A sub-admin's code also goes to every owner. Resetting the password on an
   * account that can move money is something the people responsible for that
   * account should see happen, not read about afterwards.
   */
  async requestPasswordReset(adminId: string): Promise<{ delivered: boolean; sentTo: string[] }> {
    return this.issue(adminId, AdminOtpPurpose.PASSWORD_RESET);
  }

  /**
   * Issue a code for one purpose (M7). Only a password reset is copied to the
   * owners; a sign-in or two-step code is the admin's alone.
   */
  async issue(adminId: string, purpose: AdminOtpPurpose): Promise<{ delivered: boolean; sentTo: string[] }> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });
    if (!admin || !admin.isActive) {
      throw new BadRequestException('That account cannot request a reset');
    }

    const recent = await this.prisma.adminOtp.findFirst({
      where: { adminUserId: adminId, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (recent && Date.now() - recent.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      const wait = Math.ceil(
        (RESEND_COOLDOWN_MS - (Date.now() - recent.createdAt.getTime())) / 1000,
      );
      throw new CodeCooldownError(wait);
    }

    const recipients = [admin.email];
    if (purpose === AdminOtpPurpose.PASSWORD_RESET && admin.role === AdminRole.SUB_ADMIN) {
      const owners = await this.prisma.adminUser.findMany({
        where: { role: AdminRole.OWNER, isActive: true },
        select: { email: true },
      });
      for (const o of owners) if (!recipients.includes(o.email)) recipients.push(o.email);
    }

    // randomInt is drawn from the CSPRNG, so the code is not guessable from
    // timing or from another code issued a moment earlier.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

    // Supersede anything outstanding: two live codes means a stolen older one
    // still works after the owner asked for a new one.
    await this.prisma.adminOtp.updateMany({
      where: { adminUserId: adminId, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    await this.prisma.adminOtp.create({
      data: {
        adminUserId: adminId,
        purpose,
        codeHash: this.hash(code),
        sentTo: recipients,
        expiresAt: new Date(Date.now() + TTL_MS),
      },
    });

    const expiresIn = `${TTL_MS / 60_000} minutes`;
    let delivered = false;

    for (const to of recipients) {
      const isOwnerCopy = to !== admin.email;

      /*
       * Sent through the mailer directly rather than queued.
       *
       * Everywhere else an email is queued so it cannot slow the thing that
       * caused it — but here the caller needs to know whether a code actually
       * reached an inbox before it tells somebody to go and look for one. A
       * reset that says "check your email" when nothing was sent is worse than
       * an error.
       */
      const rendered = await this.templates.render(
        isOwnerCopy ? 'admin.password_reset_notice' : TEMPLATE[purpose],
        isOwnerCopy
          ? {
              // The owner's own name is not to hand here; the greeting stays
              // generic rather than addressing them as the person resetting.
              firstName: 'there',
              code,
              expiresIn,
              adminName: admin.name,
              adminEmail: admin.email,
            }
          : { firstName: admin.name.split(' ')[0], code, expiresIn },
      );

      // Null means an admin switched this template off. A reset code is not
      // something a dashboard toggle should be able to silence, so it is sent
      // from the shipped default regardless.
      const message =
        rendered ??
        (await this.templates.render(
          isOwnerCopy ? 'admin.password_reset_notice' : TEMPLATE[purpose],
          isOwnerCopy
            ? { firstName: 'there', code, expiresIn, adminName: admin.name, adminEmail: admin.email }
            : { firstName: admin.name.split(' ')[0], code, expiresIn },
          { ignoreActive: true },
        ));
      if (!message) continue;

      const sent = await this.mail.send({
        to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        attachments: message.attachments,
        templateKey: isOwnerCopy ? 'admin.password_reset_notice' : TEMPLATE[purpose],
      });
      delivered = delivered || sent;
    }

    if (!delivered && mayLogSecrets()) {
      // Without this, no reset can be tested until SMTP exists. Guarded on the
      // environment because a production log is not a place for a live code.
      this.log.warn(`SMTP not configured — ${purpose} code for ${admin.email} is ${code}`);
    }

    return { delivered, sentTo: recipients };
  }

  /**
   * Check a code and burn it.
   *
   * Burnt whether it was right or wrong once the attempts run out, so a
   * six-digit code can never be walked through.
   */
  async consume(adminId: string, code: string, purpose: AdminOtpPurpose = AdminOtpPurpose.PASSWORD_RESET): Promise<void> {
    const id = await this.check(adminId, code, purpose);
    // Single use, even when two right answers arrive together.
    if (!(await this.consumeById(this.prisma, id))) throw new BadRequestException(NOT_RIGHT);
  }

  /**
   * C8: check a code, counting the attempt, WITHOUT using it up. The caller
   * burns it with consumeById inside the same transaction as the change it
   * authorises, so a change that fails to save leaves the code usable.
   * Burnt here only when the attempts run out, so six digits can never be walked.
   */
  async check(adminId: string, code: string, purpose: AdminOtpPurpose): Promise<string> {
    const otp = await this.prisma.adminOtp.findFirst({
      where: { adminUserId: adminId, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw new BadRequestException(NOT_RIGHT);

    if (otp.expiresAt.getTime() <= Date.now()) {
      await this.prisma.adminOtp.update({
        where: { id: otp.id },
        data: { consumedAt: new Date() },
      });
      throw new BadRequestException(NOT_RIGHT);
    }

    // Take one of the tries BEFORE looking at the code, in a single UPDATE.
    // Reading the count and adding to it later let a burst of parallel
    // requests all see "no tries used" and all get a guess in (C5).
    const slot = await this.prisma.adminOtp.updateMany({
      where: { id: otp.id, consumedAt: null, attempts: { lt: MAX_ATTEMPTS }, expiresAt: { gt: new Date() } },
      data: { attempts: { increment: 1 } },
    });
    if (slot.count === 0) {
      await this.prisma.adminOtp.updateMany({ where: { id: otp.id, consumedAt: null }, data: { consumedAt: new Date() } });
      throw new BadRequestException(NOT_RIGHT);
    }

    const given = Buffer.from(this.hash(code.trim()));
    const expected = Buffer.from(otp.codeHash);
    const matches = given.length === expected.length && timingSafeEqual(given, expected);

    if (!matches) {
      const after = await this.prisma.adminOtp.findUnique({ where: { id: otp.id }, select: { attempts: true } });
      const left = MAX_ATTEMPTS - (after?.attempts ?? MAX_ATTEMPTS);
      if (left <= 0) {
        await this.prisma.adminOtp.updateMany({ where: { id: otp.id, consumedAt: null }, data: { consumedAt: new Date() } });
      }
      throw new BadRequestException(NOT_RIGHT);
    }
    return otp.id;
  }

  /**
   * M7: the id of the open, unexpired code of this purpose that `code` is, or
   * null. Uses up no attempt: the caller limits attempts itself (a sign-in
   * challenge allows five in all, across the emailed code and backup codes).
   */
  async match(adminId: string, code: string, purpose: AdminOtpPurpose): Promise<string | null> {
    const otp = await this.prisma.adminOtp.findFirst({
      where: { adminUserId: adminId, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp || otp.expiresAt.getTime() <= Date.now()) return null;
    const given = Buffer.from(this.hash(code.trim()));
    const expected = Buffer.from(otp.codeHash);
    return given.length === expected.length && timingSafeEqual(given, expected) ? otp.id : null;
  }

  /** M7: burn a matched code, once, inside the caller's transaction. False if it was already used. */
  async consumeById(db: Pick<Prisma.TransactionClient, 'adminOtp'>, id: string): Promise<boolean> {
    const used = await db.adminOtp.updateMany({ where: { id, consumedAt: null }, data: { consumedAt: new Date() } });
    return used.count === 1;
  }
}
