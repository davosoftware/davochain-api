import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { AdminChallengeKind, AdminOtpPurpose, AdminRole, AlertType, Prisma } from '@prisma/client';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { SystemFlagsService } from '../common/system-flags.service';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { MailService } from '../common/mail.service';
import { EmailTemplateService } from '../cms/email-template.service';
import { recordFailedLogin } from '../auth/failed-logins';
import { AdminOtpService, CodeCooldownError } from './otp.service';
import { AdminSessionsService } from './sessions.service';
import { WRONG_PASSWORD_MESSAGE } from './ngn-withdrawals.service';

/** System flag: an owner requires two-step sign-in for every admin. */
export const TWO_STEP_REQUIRED_FLAG = 'admin_two_step_required';

const CHALLENGE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const BACKUP_CODES = 10;
const NOT_RIGHT = 'That code is not right.';
const TICKET_BAD = 'That code is not right or has expired. Sign in again.';

type Db = Pick<Prisma.TransactionClient, 'adminUser' | 'adminLoginChallenge' | 'adminBackupCode' | 'adminOtp'>;
type Actor = { id: string; role: AdminRole };
type AdminRow = { id: string; email: string; name: string; role: AdminRole; isActive: boolean; twoStepEnabled: boolean; lockedUntil: Date | null; passwordHash: string };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const sameHash = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** "ada@davochain.test" → "a**@davochain.test": enough to recognise, not to harvest. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
}

/**
 * Admin two-step sign-in (M7, spec docs/superpowers/specs/2026-10-20-admin-two-step-design.md).
 *
 * A sign-in that passed the password becomes a challenge: the browser holds a
 * random ticket, the database only its hash. The second step (the emailed code
 * or one of 10 backup codes) trades the ticket for a token, once. Every wrong
 * code counts toward the ordinary lockout, and a challenge allows 5 tries.
 */
@Injectable()
export class TwoStepService {
  private readonly log = new Logger(TwoStepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly otps: AdminOtpService,
    private readonly passwords: PasswordService,
    private readonly flags: SystemFlagsService,
    private readonly sessions: AdminSessionsService,
    private readonly alerts: OpsAlertsService,
    @Optional() private readonly mail?: MailService,
    @Optional() private readonly templates?: EmailTemplateService,
  ) {}

  isRequired(): Promise<boolean> {
    return this.flags.get<boolean>(TWO_STEP_REQUIRED_FLAG, false);
  }

  // ── sign-in ──────────────────────────────────────────────

  async startChallenge(admin: { id: string }, kind: AdminChallengeKind | 'CODE' | 'SETUP', ip?: string): Promise<{ ticket: string }> {
    const ticket = randomBytes(32).toString('base64url');
    await this.prisma.adminLoginChallenge.create({
      data: { adminUserId: admin.id, ticketHash: sha(ticket), kind: kind as AdminChallengeKind, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS), ip: ip ?? null },
    });
    return { ticket };
  }

  /**
   * Email the code this sign-in needs (first send and "Send a new code"). Uses no attempt.
   *
   * \`reuseRecent\` (the sign-in itself): when a code of this kind went out less
   * than a minute ago, that code is still good, so signing in again straight
   * away reuses it instead of failing. "Send a new code" keeps the wait.
   */
  async sendCode(ticket: string, opts: { reuseRecent?: boolean } = {}): Promise<{ delivered: boolean; sentTo: string }> {
    const { challenge, admin } = await this.openChallenge(ticket);
    const purpose = challenge.kind === AdminChallengeKind.SETUP ? AdminOtpPurpose.TWO_STEP_CHANGE : AdminOtpPurpose.LOGIN;
    try {
      const { delivered } = await this.otps.issue(admin.id, purpose);
      return { delivered, sentTo: maskEmail(admin.email) };
    } catch (err) {
      if (opts.reuseRecent && err instanceof CodeCooldownError) return { delivered: true, sentTo: maskEmail(admin.email) };
      throw err;
    }
  }

  /** Finish a CODE sign-in with the emailed code or a backup code. */
  async verifyLogin(ticket: string, code: string): Promise<{ admin: AdminRow; usedBackup: boolean; backupLeft: number }> {
    const { challenge, admin } = await this.takeChallenge(ticket, AdminChallengeKind.CODE);
    const otpId = await this.otps.match(admin.id, code, AdminOtpPurpose.LOGIN);
    const backupId = otpId ? null : await this.findBackup(this.prisma, admin.id, code);
    if (!otpId && !backupId) {
      await this.wrongCode(admin);
      throw new BadRequestException(NOT_RIGHT);
    }

    await this.prisma.$transaction(async (tx) => {
      await this.consumeChallenge(tx, challenge.id);
      const used = otpId ? await this.otps.consumeById(tx, otpId) : await this.useBackup(tx, backupId!);
      if (!used) throw new BadRequestException(NOT_RIGHT);
      await tx.adminUser.update({ where: { id: admin.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
    });

    const backupLeft = await this.prisma.adminBackupCode.count({ where: { adminUserId: admin.id, usedAt: null } });
    if (backupId) void this.notice(admin, 'admin.two_step_backup_used', { left: String(backupLeft) });
    return { admin, usedBackup: Boolean(backupId), backupLeft };
  }

  /** Finish a SETUP sign-in: the emailed code switches two-step on and hands out the backup codes. */
  async completeSetup(ticket: string, code: string): Promise<{ admin: AdminRow; backupCodes: string[] }> {
    const { challenge, admin } = await this.takeChallenge(ticket, AdminChallengeKind.SETUP);
    const otpId = await this.otps.match(admin.id, code, AdminOtpPurpose.TWO_STEP_CHANGE);
    if (!otpId) {
      await this.wrongCode(admin);
      throw new BadRequestException(NOT_RIGHT);
    }
    const backupCodes = await this.prisma.$transaction(async (tx) => {
      await this.consumeChallenge(tx, challenge.id);
      if (!(await this.otps.consumeById(tx, otpId))) throw new BadRequestException(NOT_RIGHT);
      await tx.adminUser.update({
        where: { id: admin.id },
        data: { twoStepEnabled: true, twoStepEnabledAt: new Date(), failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
      });
      return this.generateBackupCodes(tx, admin.id);
    });
    return { admin, backupCodes };
  }

  // ── backup codes ─────────────────────────────────────────

  /** Ten new codes, replacing any earlier set. Shown once; stored as hashes. */
  async generateBackupCodes(db: Pick<Db, 'adminBackupCode'>, adminId: string): Promise<string[]> {
    const codes = new Set<string>();
    while (codes.size < BACKUP_CODES) codes.add(String(randomInt(0, 1_000_000)).padStart(6, '0'));
    const list = [...codes];
    await db.adminBackupCode.deleteMany({ where: { adminUserId: adminId } });
    await db.adminBackupCode.createMany({ data: list.map((c) => ({ adminUserId: adminId, codeHash: sha(c) })) });
    return list;
  }

  private async findBackup(db: Pick<Db, 'adminBackupCode'>, adminId: string, code: string): Promise<string | null> {
    const unused = await db.adminBackupCode.findMany({ where: { adminUserId: adminId, usedAt: null } });
    const given = sha(code.trim());
    let found: string | null = null;
    for (const b of unused) if (sameHash(given, b.codeHash)) found = b.id; // no early exit: same time for every row
    return found;
  }

  private async useBackup(db: Pick<Db, 'adminBackupCode'>, id: string): Promise<boolean> {
    const used = await db.adminBackupCode.updateMany({ where: { id, usedAt: null }, data: { usedAt: new Date() } });
    return used.count === 1;
  }

  // ── my account ───────────────────────────────────────────

  async status(adminId: string) {
    const admin = await this.mustFind(adminId);
    const backupCodesLeft = await this.prisma.adminBackupCode.count({ where: { adminUserId: adminId, usedAt: null } });
    return {
      enabled: admin.twoStepEnabled,
      enabledAt: (admin as AdminRow & { twoStepEnabledAt?: Date | null }).twoStepEnabledAt ?? null,
      backupCodesLeft: admin.twoStepEnabled ? backupCodesLeft : 0,
      required: await this.isRequired(),
    };
  }

  /** Password first, then an emailed code to confirm switching on or off. */
  async sendChangeCode(adminId: string, password: string): Promise<{ delivered: boolean; sentTo: string }> {
    const admin = await this.checkPassword(adminId, password);
    const { delivered } = await this.otps.issue(admin.id, AdminOtpPurpose.TWO_STEP_CHANGE);
    return { delivered, sentTo: maskEmail(admin.email) };
  }

  async enable(adminId: string, code: string, currentJti: string): Promise<{ backupCodes: string[] }> {
    const admin = await this.mustFind(adminId);
    if (admin.twoStepEnabled) throw new ConflictException('Two-step sign-in is already on.');
    await this.otps.consume(adminId, code, AdminOtpPurpose.TWO_STEP_CHANGE);
    const backupCodes = await this.prisma.$transaction(async (tx) => {
      await tx.adminUser.update({ where: { id: adminId }, data: { twoStepEnabled: true, twoStepEnabledAt: new Date() } });
      return this.generateBackupCodes(tx, adminId);
    });
    // Sessions opened with the password alone end now; this one carries on.
    await this.sessions.revokeAllFor(adminId, 'two-step sign-in switched on', currentJti);
    return { backupCodes };
  }

  async regenerate(adminId: string, password: string): Promise<string[]> {
    const admin = await this.mustFind(adminId);
    if (!admin.twoStepEnabled) throw new ConflictException('Turn on two-step sign-in first.');
    await this.checkPassword(adminId, password);
    return this.prisma.$transaction((tx) => this.generateBackupCodes(tx, adminId));
  }

  async disable(adminId: string, password: string, code: string): Promise<void> {
    if (await this.isRequired()) {
      throw new ConflictException('An owner requires two-step sign-in for every admin, so it cannot be turned off.');
    }
    const admin = await this.mustFind(adminId);
    if (!admin.twoStepEnabled) throw new ConflictException('Two-step sign-in is already off.');
    await this.checkPassword(adminId, password);
    const backupId = await this.findBackup(this.prisma, adminId, code);
    await this.prisma.$transaction(async (tx) => {
      if (backupId) {
        if (!(await this.useBackup(tx, backupId))) throw new BadRequestException(NOT_RIGHT);
      } else {
        await this.otps.consume(adminId, code, AdminOtpPurpose.TWO_STEP_CHANGE);
      }
      await tx.adminUser.update({ where: { id: adminId }, data: { twoStepEnabled: false, twoStepEnabledAt: null } });
      await tx.adminBackupCode.deleteMany({ where: { adminUserId: adminId } });
    });
    void this.notice(admin, 'admin.two_step_disabled', {});
  }

  /** Owners only: require two-step sign-in for every admin. */
  async setRequired(actor: Actor, required: boolean, password: string): Promise<{ before: boolean; after: boolean }> {
    if (actor.role !== AdminRole.OWNER) throw new ForbiddenException('Only an owner can do this');
    const owner = await this.checkPassword(actor.id, password);
    if (required && !owner.twoStepEnabled) {
      throw new ConflictException('Turn on two-step sign-in for your own account first.');
    }
    const before = await this.isRequired();
    await this.flags.set(TWO_STEP_REQUIRED_FLAG, required, actor.id);
    return { before, after: required };
  }

  // ── helpers ──────────────────────────────────────────────

  private async mustFind(adminId: string): Promise<AdminRow> {
    const admin = (await this.prisma.adminUser.findUnique({ where: { id: adminId } })) as AdminRow | null;
    if (!admin) throw new UnauthorizedException('Account not found');
    return admin;
  }

  private async checkPassword(adminId: string, password: string): Promise<AdminRow> {
    const admin = await this.mustFind(adminId);
    if (!(await this.passwords.verify(password, admin.passwordHash))) {
      await this.wrongCode(admin);
      throw new BadRequestException(WRONG_PASSWORD_MESSAGE);
    }
    return admin;
  }

  /** The challenge behind a ticket, open, for an active and unlocked admin. Uses no attempt. */
  private async openChallenge(ticket: string) {
    const challenge = await this.prisma.adminLoginChallenge.findUnique({ where: { ticketHash: sha(String(ticket)) } });
    if (!challenge || challenge.consumedAt || challenge.expiresAt.getTime() <= Date.now() || challenge.attempts >= MAX_ATTEMPTS) {
      throw new UnauthorizedException(TICKET_BAD);
    }
    const admin = (await this.prisma.adminUser.findUnique({ where: { id: challenge.adminUserId } })) as AdminRow | null;
    if (!admin || !admin.isActive || (admin.lockedUntil && admin.lockedUntil > new Date())) {
      throw new UnauthorizedException(TICKET_BAD);
    }
    return { challenge, admin };
  }

  /** openChallenge, of this kind, and one of its 5 attempts taken in a single UPDATE (C5). */
  private async takeChallenge(ticket: string, kind: AdminChallengeKind) {
    const found = await this.openChallenge(ticket);
    if (found.challenge.kind !== kind) throw new UnauthorizedException(TICKET_BAD);
    const slot = await this.prisma.adminLoginChallenge.updateMany({
      where: { id: found.challenge.id, consumedAt: null, attempts: { lt: MAX_ATTEMPTS }, expiresAt: { gt: new Date() } },
      data: { attempts: { increment: 1 } },
    });
    if (slot.count === 0) throw new UnauthorizedException(TICKET_BAD);
    return found;
  }

  /** Single use, even when two right answers arrive together. */
  private async consumeChallenge(db: Pick<Db, 'adminLoginChallenge'>, id: string): Promise<void> {
    const used = await db.adminLoginChallenge.updateMany({ where: { id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (used.count !== 1) throw new UnauthorizedException(TICKET_BAD);
  }

  /** A wrong code or password counts toward the ordinary admin lockout. */
  private async wrongCode(admin: { id: string; email: string }): Promise<void> {
    const r = await this.recordFailure(admin.id);
    if (r.justLocked) {
      void this.alerts
        .raise(AlertType.ADMIN_LOCKOUT, `admin-lockout:${admin.id}`, 'An admin account was locked after repeated wrong codes', [
          `Admin: ${admin.email}`,
          'Five wrong sign-in codes or passwords in a row. If this was not them, someone has their password.',
        ])
        .catch(() => undefined);
    }
  }

  protected async recordFailure(adminId: string): Promise<{ justLocked: boolean }> {
    return recordFailedLogin(this.prisma, 'admin_users', adminId);
  }

  /** A security notice by email. Best effort: it must never change the answer. */
  protected async notice(admin: { email: string; name: string }, key: string, vars: Record<string, string>): Promise<void> {
    if (!this.mail || !this.templates) return;
    try {
      const all = { firstName: admin.name.split(' ')[0], ...vars };
      const msg = (await this.templates.render(key, all)) ?? (await this.templates.render(key, all, { ignoreActive: true }));
      if (msg) await this.mail.send({ to: admin.email, subject: msg.subject, text: msg.text, html: msg.html, templateKey: key });
    } catch (err) {
      this.log.warn(`Could not send ${key} to ${admin.email}: ${(err as Error).message}`);
    }
  }
}
