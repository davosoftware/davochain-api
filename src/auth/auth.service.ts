import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { KycStatus, KycTier, UserStatus } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PasswordService } from './password.service';
import { TemplatedMailService } from '../cms/templated-mail.service';
import { formatLagos } from '../common/dates';
import { UserOtpService } from './user-otp.service';
import { ReferralsService } from '../referrals/referrals.service';
import { JOBS, QUEUES, jobId } from '../common/queues';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

export interface JwtPayload {
  sub: string;
  email: string;
  tier: KycTier;
  kyc: KycStatus;
  typ: 'access';
}

interface SessionContext {
  userAgent?: string;
  ip?: string;
}

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    @InjectQueue(QUEUES.PROVISIONING) private readonly provisioning: Queue,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mail: TemplatedMailService,
    private readonly otps: UserOtpService,
    private readonly referrals: ReferralsService,
  ) {}

  // ── registration ────────────────────────────────────────────

  async register(
    input: {
      email: string;
      password: string;
      firstName: string;
      lastName: string;
      phone?: string;
      referralCode?: string;
    },
    ctx: SessionContext = {},
  ): Promise<AuthTokens & { userId: string }> {
    const email = input.email.trim().toLowerCase();

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      // Do not confirm which addresses are registered.
      throw new BadRequestException('Unable to register with those details');
    }

    const passwordHash = await this.passwords.hash(input.password);

    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        phone: input.phone?.trim() || null,
        isTest: this.config.get<string>('NODE_ENV') !== 'production',
        kycProfile: { create: { tier: KycTier.TIER_0, status: KycStatus.NOT_STARTED } },
      },
    });

    // The Quidax sub-account is provisioned on a worker: a signup must not fail
    // because an upstream call did, and the user has no use for a wallet until
    // they reach the crypto page. jobId dedupes a double-submitted signup.
    //
    // If this enqueue fails, nothing is lost — requireQuidaxId() provisions on
    // demand the first time an address is requested. It would just be slower,
    // and walletReady would stay false until then.
    await this.provisioning
      .add(JOBS.PROVISION_SUBACCOUNT, { userId: user.id }, { jobId: jobId('provision', user.id) })
      .catch((err: Error) =>
        this.log.error(`Could not queue provisioning for ${user.id}: ${err.message}`),
      );

    this.log.log(`Registered ${user.id}`);

    /*
     * Attach the referrer, if they came through a code.
     *
     * After the account exists and deliberately outside any transaction of
     * its own. A promotion that misbehaves must never be the reason somebody
     * cannot open an account, so this both swallows its errors and treats an
     * unrecognised code as no code at all.
     *
     * This is the ONLY place a referrer is ever attached.
     */
    if (input.referralCode) {
      await this.referrals
        .attach(user.id, input.referralCode)
        .catch((err: Error) =>
          this.log.error(`Referral attach failed for ${user.id}: ${err.message}`),
        );
    }

    // Queued, so a slow mailer cannot make a signup feel broken. Its own
    // template switch decides whether it actually goes.
    await this.mail.send({
      key: 'user.welcome',
      to: user.email,
      variables: { firstName: user.firstName, lastName: user.lastName, email: user.email },
      dedupeOn: user.id,
    });

    /*
     * The same flat shape login and refresh return, plus the new id.
     *
     * Registering and signing in hand back the same thing, so a client reads
     * `accessToken` from one place and stores a session with one function.
     * Nesting the tokens here — as this used to — meant every new client wrote
     * the unwrapping code once, wrongly, and found out at the first signup.
     */
    return { ...(await this.issueTokens(user.id, ctx)), userId: user.id };
  }

  // ── login ───────────────────────────────────────────────────

  async login(email: string, password: string, ctx: SessionContext = {}): Promise<AuthTokens> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });

    // Same shape and roughly the same cost whether or not the account exists.
    if (!user) {
      await this.passwords.dummyVerify();
      throw new UnauthorizedException('Incorrect email or password');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ForbiddenException(
        `Too many failed attempts. Try again after ${user.lockedUntil.toISOString()}`,
      );
    }

    const ok = await this.passwords.verify(password, user.passwordHash);
    if (!ok) {
      await this.recordFailedLogin(user.id, user.failedLogins);
      throw new UnauthorizedException('Incorrect email or password');
    }

    /*
     * A suspended account gets a distinct, machine-readable shape so the app
     * can route to a dedicated screen rather than showing a generic error.
     * The reason is admin-written and shown verbatim — "contact support" with
     * no explanation is what makes people file tickets.
     *
     * The password was verified first on purpose: telling someone their account
     * is suspended before they prove who they are leaks account state to anyone
     * who guesses an email.
     */
    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException({
        code: 'ACCOUNT_SUSPENDED',
        message: user.suspendedReason?.trim()
          ? user.suspendedReason
          : 'Your account has been suspended. Contact support to resolve this.',
        suspendedAt: user.suspendedAt,
      });
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException({
        code: 'ACCOUNT_CLOSED',
        message: 'This account is closed. Contact support.',
      });
    }

    // Opportunistically upgrade a hash made under weaker parameters.
    const data: Record<string, unknown> = {
      failedLogins: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    };
    if (this.passwords.needsRehash(user.passwordHash)) {
      data.passwordHash = await this.passwords.hash(password);
    }
    await this.prisma.user.update({ where: { id: user.id }, data });

    return this.issueTokens(user.id, ctx);
  }

  private async recordFailedLogin(userId: string, current: number): Promise<void> {
    const next = current + 1;
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLogins: next,
        lockedUntil:
          next >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : undefined,
      },
    });
  }

  // ── tokens ──────────────────────────────────────────────────

  private async issueTokens(
    userId: string,
    ctx: SessionContext,
    family?: string,
  ): Promise<AuthTokens> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      tier: user.kycTier,
      kyc: user.kycStatus,
      typ: 'access',
    };

    const expiresIn = this.config.get<string>('JWT_EXPIRES_IN') ?? '15m';
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_SECRET'),
      // jsonwebtoken types expiresIn as a template literal; the value is validated at boot.
      expiresIn: expiresIn as unknown as number,
    });

    // Opaque, high-entropy, stored only as a hash.
    const refreshToken = randomBytes(48).toString('base64url');
    const days = this.parseDays(this.config.get<string>('JWT_REFRESH_EXPIRES_IN') ?? '30d');

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(refreshToken),
        family: family ?? randomUUID(),
        userAgent: ctx.userAgent?.slice(0, 255),
        ip: ctx.ip,
        expiresAt: new Date(Date.now() + days * 86_400_000),
      },
    });

    return { accessToken, refreshToken, expiresIn };
  }

  /**
   * Rotate. Presenting a token that has already been used means it leaked, so
   * the entire family is revoked rather than just that token.
   */
  async refresh(refreshToken: string, ctx: SessionContext = {}): Promise<AuthTokens> {
    const tokenHash = this.hashToken(refreshToken);
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!record) throw new UnauthorizedException('Invalid refresh token');

    if (record.revokedAt) {
      this.log.warn(`Reuse of a revoked refresh token — revoking family ${record.family}`);
      await this.prisma.refreshToken.updateMany({
        where: { family: record.family, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }

    if (record.expiresAt < new Date()) {
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }

    const tokens = await this.issueTokens(record.userId, ctx, record.family);
    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date(), replacedBy: this.hashToken(tokens.refreshToken) },
    });

    return tokens;
  }

  async logout(refreshToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Sign out everywhere — used on password change and by support. */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await this.passwords.verify(currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await this.passwords.hash(newPassword) },
    });
    // A password change invalidates every session, including the one that made it.
    await this.revokeAllSessions(userId);
    await this.announcePasswordChange(user, 'with the current password');
  }

  /**
   * Start a reset for somebody who cannot sign in.
   *
   * Unauthenticated by necessity. The response never says whether the email
   * matched an account — a different answer is a way to find out which
   * addresses are registered here.
   */
  async requestPasswordReset(email: string): Promise<void> {
    await this.otps.request(email);
  }

  /**
   * Finish it: check the code, set the new password, sign everything out.
   *
   * Deliberately returns no session. Somebody who has just proved control of an
   * inbox has proved less than somebody who typed a password, and handing them
   * a signed-in session on the strength of a six-digit code makes the code as
   * good as the password. They sign in with what they chose.
   */
  async resetPassword(email: string, code: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: { id: true, email: true, firstName: true, lastName: true, passwordHash: true, status: true },
    });

    // Same message the wrong-code path gives, for the same reason.
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('That code is not right.');
    }

    await this.otps.consume(user.id, code);

    if (await this.passwords.verify(newPassword, user.passwordHash)) {
      throw new BadRequestException('That is the password you already had. Choose a different one.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await this.passwords.hash(newPassword), failedLogins: 0, lockedUntil: null },
    });

    // Whoever was signed in before is signed out now — if the account was taken
    // over, this is what ends the intruder's session.
    await this.revokeAllSessions(user.id);
    await this.announcePasswordChange(user, 'using an emailed code');

    this.log.warn(`Password reset by code for ${user.id}`);
  }

  /**
   * The security notice.
   *
   * Sent after the change, not before: it is how somebody whose account was
   * taken over finds out, and it is worth sending every time — so no dedupe
   * key.
   */
  private async announcePasswordChange(
    user: { email: string; firstName: string; lastName: string },
    method: string,
  ): Promise<void> {
    await this.mail.send({
      key: 'user.password_changed',
      to: user.email,
      variables: {
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        changedAt: formatLagos(new Date()),
        method,
      },
    });
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private parseDays(spec: string): number {
    const m = /^(\d+)([dhm])$/.exec(spec);
    if (!m) return 30;
    const n = Number(m[1]);
    return m[2] === 'd' ? n : m[2] === 'h' ? n / 24 : n / 1440;
  }
}
