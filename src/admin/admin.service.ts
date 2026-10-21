import { BadRequestException, ConflictException, Injectable, Logger, UnauthorizedException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AdminRole, AlertType, KycStatus, KycTier } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TemplatedMailService } from '../cms/templated-mail.service';
import { ReferralsService } from '../referrals/referrals.service';
import { PasswordService } from '../auth/password.service';
import { recordFailedLogin } from '../auth/failed-logins';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { RatesService } from '../rates/rates.service';
import { AdminSessionsService } from './sessions.service';
import { TwoStepService } from './two-step.service';
import { dec, str } from '../common/money';

/** M7: a sign-in either finishes, or waits for its second step. */
export type AdminLoginResult =
  | { accessToken: string }
  | { twoStep: 'CODE' | 'SETUP'; ticket: string; sentTo: string; delivered: boolean };

export interface AdminJwtPayload {
  sub: string;
  email: string;
  typ: 'admin';
  role: AdminRole;
  /// Ties the bearer to a session row, so the session can be ended.
  jti: string;
  iat?: number;
}

@Injectable()
export class AdminService {
  private readonly log = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly rates: RatesService,
    private readonly sessions: AdminSessionsService,
    private readonly mail: TemplatedMailService,
    private readonly referrals: ReferralsService,
    private readonly alerts: OpsAlertsService,
    @Optional() private readonly twoStep?: TwoStepService,
  ) {}

  async login(
    email: string,
    password: string,
    context?: { ip?: string; userAgent?: string },
  ): Promise<AdminLoginResult> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    if (!admin || !admin.isActive) {
      await this.passwords.dummyVerify();
      await this.sameCostAsAFailure();
      throw new UnauthorizedException('Incorrect email or password');
    }

    /*
     * Locked (spec §4.2): answered exactly like a wrong password, and at the
     * same cost. Admin emails are not public; a distinct "locked" reply, or a
     * suspiciously fast one, would confirm an address is a real admin after
     * five guesses. The admin learns of the lock from the ADMIN_LOCKOUT alert
     * and the audit log, and it lifts after 15 minutes or a password reset.
     */
    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      await this.passwords.dummyVerify();
      await this.sameCostAsAFailure();
      throw new UnauthorizedException('Incorrect email or password');
    }

    // A full hash queue throws a 503 here, before anything is counted.
    if (!(await this.passwords.verify(password, admin.passwordHash))) {
      const failed = await recordFailedLogin(this.prisma, 'admin_users', admin.id);
      // Not awaited: the alert emails out, and waiting for SMTP would both delay
      // this answer (revealing a real admin) and hang it if mail is down.
      if (failed.justLocked) void this.onLocked(admin, failed.lockedUntil, context).catch(() => undefined);
      throw new UnauthorizedException('Incorrect email or password');
    }

    /*
     * M7: with two-step on (or required by an owner), the right password only
     * opens the second step. The failed-attempt count is NOT reset here: only a
     * full sign-in resets it, or "right password, four wrong codes, right
     * password again" would allow endless code guessing.
     */
    if (this.twoStep) {
      const kind = admin.twoStepEnabled ? 'CODE' : (await this.twoStep.isRequired()) ? 'SETUP' : null;
      if (kind) {
        const { ticket } = await this.twoStep.startChallenge(admin, kind, context?.ip);
        const { delivered, sentTo } = await this.twoStep.sendCode(ticket, { reuseRecent: true });
        return { twoStep: kind, ticket, sentTo, delivered };
      }
    }

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null },
    });

    return { accessToken: await this.signToken(admin, context) };
  }

  /**
   * The database work a wrong password does (the counting transaction), on a
   * row that does not exist. Without it an unknown, inactive or locked address
   * answers measurably faster than a real admin's wrong password, and the
   * timing alone says which emails are admins.
   */
  private async sameCostAsAFailure(): Promise<void> {
    try {
      await recordFailedLogin(this.prisma, 'admin_users', randomUUID());
    } catch {
      // Only the time it takes matters here; a failure must not change the answer.
    }
  }

  /**
   * An admin account just locked. That usually means someone is guessing its
   * password, so it is written down and an alert goes out. Neither may turn
   * the sign-in answer into something other than "incorrect".
   */
  private async onLocked(
    admin: { id: string; email: string },
    lockedUntil: Date | null,
    context?: { ip?: string; userAgent?: string },
  ): Promise<void> {
    const until = lockedUntil?.toISOString() ?? 'unknown';
    try {
      await this.audit(
        admin.id,
        'admin.locked',
        'AdminUser',
        admin.id,
        null,
        { lockedUntil: until, userAgent: context?.userAgent ?? null },
        context?.ip,
      );
    } catch (err) {
      this.log.error(`Could not audit the lockout of ${admin.email}: ${(err as Error).message}`);
    }
    await this.alerts.raise(
      AlertType.ADMIN_LOCKOUT,
      `admin-lockout:${admin.id}`,
      'An admin account was locked after repeated wrong passwords',
      [
        `Admin: ${admin.email}`,
        `From IP: ${context?.ip ?? 'unknown'}`,
        `Locked until: ${until}`,
        'If this was not them, someone is guessing the password. Check the audit log for admin.locked.',
        'While locked, the sign-in page says "Incorrect email or password" even for the right password.',
      ],
    );
  }

  /**
   * Extracted so a password change can hand back a fresh token in the same
   * breath as invalidating every other session — otherwise the admin doing the
   * changing is signed out by their own action.
   */
  async signToken(
    admin: { id: string; email: string; role: AdminRole },
    context?: { ip?: string; userAgent?: string },
  ): Promise<string> {
    const jti = randomUUID();
    const payload: AdminJwtPayload = {
      sub: admin.id,
      email: admin.email,
      typ: 'admin',
      role: admin.role,
      jti,
    };

    const token = await this.jwt.signAsync(payload, {
      // A separate secret: a leaked user token must never work here.
      secret: this.config.getOrThrow<string>('ADMIN_JWT_SECRET'),
      expiresIn: (this.config.get<string>('ADMIN_JWT_EXPIRES_IN') ?? '8h') as unknown as number,
    });

    // The row is what makes the token revocable. Sign first so a failure here
    // cannot leave a usable token with no session behind it — a token whose
    // session is missing is refused, which is the safe direction to fail.
    const decoded = this.jwt.decode<{ exp: number }>(token);
    await this.sessions.start({
      adminUserId: admin.id,
      jti,
      expiresAt: new Date(decoded.exp * 1000),
      ip: context?.ip,
      userAgent: context?.userAgent,
    });

    return token;
  }

  /**
   * Rate configs are VERSIONED. Insert a new row, never update — a dispute six
   * weeks from now has to be answerable with the gate that was live at that
   * moment, and an UPDATE destroys that.
   */
  async setGate(
    adminId: string,
    assetCode: string,
    changes: {
      gateNgnPerUsd?: string;
      swapFeeUsd?: string;
      floorUsd?: string;
      maxTradeUsd?: string;
      withdrawalFee?: string;
      quoteTtlSeconds?: number;
      note?: string;
    },
  ) {
    const current = await this.rates.rateConfig(assetCode);

    const created = await this.prisma.rateConfig.create({
      data: {
        assetCode: assetCode.toLowerCase(),
        gateNgnPerUsd: changes.gateNgnPerUsd ?? current.gateNgnPerUsd,
        swapFeeUsd: changes.swapFeeUsd ?? current.swapFeeUsd,
        floorUsd: changes.floorUsd ?? current.floorUsd,
        maxTradeUsd: changes.maxTradeUsd ?? current.maxTradeUsd,
        withdrawalFee: changes.withdrawalFee ?? current.withdrawalFee,
        quoteTtlSeconds: changes.quoteTtlSeconds ?? current.quoteTtlSeconds,
        setBy: adminId,
        note: changes.note ?? null,
      },
    });

    await this.audit(adminId, 'rate_config.set', 'RateConfig', created.id, current, created);
    this.log.warn(
      `Gate for ${assetCode} changed by ${adminId}: ` +
        `${str(current.gateNgnPerUsd)} -> ${str(created.gateNgnPerUsd)}`,
    );
    return created;
  }

  async gates() {
    const assets = await this.prisma.asset.findMany({
      where: { isListed: true, isFiat: false },
      orderBy: { sortOrder: 'asc' },
    });

    return Promise.all(
      assets.map(async (a) => {
        const cfg = await this.rates.rateConfig(a.code);
        return {
          asset: a.code,
          name: a.name,
          gateNgnPerUsd: str(cfg.gateNgnPerUsd, 2),
          swapFeeUsd: str(cfg.swapFeeUsd, 2),
          floorUsd: str(cfg.floorUsd, 2),
          maxTradeUsd: str(cfg.maxTradeUsd, 2),
          withdrawalFee: str(cfg.withdrawalFee, 8),
          quoteTtlSeconds: cfg.quoteTtlSeconds,
          effectiveFrom: cfg.effectiveFrom,
          setBy: cfg.setBy,
        };
      }),
    );
  }

  /**
   * Realised margin against expected, per coin.
   *
   * A coin whose realised margin sits consistently below its gate is being
   * picked off on a stale quote — the fix is a wider gate on that coin or a
   * shorter TTL, not a bigger spread everywhere.
   */
  async margin(days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);
    const trades = await this.prisma.transaction.findMany({
      where: {
        status: 'COMPLETED',
        type: { in: ['BUY', 'SELL'] },
        createdAt: { gte: since },
        gateApplied: { not: null },
      },
      select: {
        toAsset: true,
        fromAsset: true,
        fromAmount: true,
        toAmount: true,
        gateApplied: true,
        displayedRate: true,
        quidaxRate: true,
        type: true,
      },
    });

    const byAsset = new Map<string, { expected: ReturnType<typeof dec>; count: number }>();
    for (const t of trades) {
      const asset = t.type === 'BUY' ? t.toAsset! : t.fromAsset!;
      const ngn = dec(t.type === 'BUY' ? (t.fromAmount ?? 0) : (t.toAmount ?? 0));
      const rate = dec(t.displayedRate ?? 1);
      const usdValue = rate.isZero() ? dec(0) : ngn.div(rate);
      const expected = usdValue.mul(dec(t.gateApplied ?? 0));

      const row = byAsset.get(asset) ?? { expected: dec(0), count: 0 };
      row.expected = row.expected.plus(expected);
      row.count += 1;
      byAsset.set(asset, row);
    }

    return [...byAsset.entries()].map(([asset, row]) => ({
      asset,
      trades: row.count,
      expectedMarginNgn: row.expected.toFixed(0),
    }));
  }

  async transactions(filters: { status?: string; type?: string; userId?: string; limit?: number }) {
    const rows = await this.prisma.transaction.findMany({
      where: {
        ...(filters.status ? { status: filters.status as never } : {}),
        ...(filters.type ? { type: filters.type as never } : {}),
        ...(filters.userId ? { userId: filters.userId } : {}),
      },
      include: { legs: true, user: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filters.limit ?? 100, 500),
    });

    return rows.map((t) => ({
      id: t.id,
      user: t.user.email,
      type: t.type,
      status: t.status,
      // Keep the upstream string verbatim — the vocabularies differ per endpoint.
      quidaxRawStatus: t.quidaxRawStatus,
      fromAsset: t.fromAsset,
      fromAmount: t.fromAmount ? str(t.fromAmount) : null,
      toAsset: t.toAsset,
      toAmount: t.toAmount ? str(t.toAmount) : null,
      settledFrom: t.settledFrom,
      failureReason: t.failureReason,
      legs: t.legs.map((l) => ({
        kind: l.kind,
        state: l.state,
        amount: str(l.amount),
        reference: l.reference,
        lastError: l.lastError,
      })),
      createdAt: t.createdAt,
    }));
  }

  async reviewKyc(
    adminId: string,
    userId: string,
    decision: { approve: boolean; tier?: KycTier; reason?: string },
  ) {
    const tier = decision.tier ?? KycTier.TIER_1;
    if (decision.approve && tier === KycTier.TIER_1) {
      // Basic is decided by the Dojah lookup, its AML screen and their reviews
      // (plan ruling 8). This route stays for the Advanced tiers.
      throw new BadRequestException('Basic is decided through basic-decision');
    }
    // Final review I4: a Basic verification in progress is decided only through its own flow.
    const active = await this.prisma.kycVerification.findFirst({ where: { activeFor: userId }, select: { id: true } });
    if (active) throw new ConflictException('This person is in Basic verification. Decide it from the Basic review or Compliance review.');
    // Spec 2026-10-21 §8: an open Advanced attempt is decided only on its own page.
    const advancedOpen = await this.prisma.advancedVerification.findFirst({ where: { activeFor: userId }, select: { id: true } });
    if (advancedOpen) throw new ConflictException('This person has an Advanced check open. Decide it on the Advanced page.');
    const profile = await this.prisma.kycProfile.findUniqueOrThrow({ where: { userId } });

    const [updated] = await this.prisma.$transaction([
      this.prisma.kycProfile.update({
        where: { userId },
        data: {
          status: decision.approve ? KycStatus.APPROVED : KycStatus.REJECTED,
          tier: decision.approve ? tier : profile.tier,
          reviewedAt: new Date(),
          reviewedBy: adminId,
          rejectionReason: decision.approve ? null : (decision.reason ?? 'Not specified'),
        },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          kycStatus: decision.approve ? KycStatus.APPROVED : KycStatus.REJECTED,
          kycTier: decision.approve ? tier : profile.tier,
        },
      }),
      // The tier is carried in the JWT, so an existing token still reads the
      // old one. Revoking sessions is what makes the change take effect now
      // rather than whenever the access token happens to expire.
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    // Their sessions were just revoked to make the new tier take effect, so the
    // app will bounce them to sign in. Email is what explains why.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, firstName: true, lastName: true },
    });
    if (user) {
      await this.mail.send({
        key: decision.approve ? 'kyc.approved' : 'kyc.rejected',
        to: user.email,
        variables: {
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          tier,
          reason: decision.reason ?? 'Not specified',
        },
      });
    }

    /*
     * A verification may have just earned two people money.
     *
     * Both sides, because a referrer's reward hangs on somebody else's tier —
     * theirs is the account that changed, but it is their referrer who gets
     * paid for it. Never throws: a promotion that cannot pay must not turn an
     * approved KYC into a failed request.
     */
    if (decision.approve) {
      await this.referrals.onKycChanged(userId);
    }

    await this.audit(adminId, 'kyc.review', 'KycProfile', profile.id, profile, updated);
    return updated;
  }

  async audit(
    adminUserId: string,
    action: string,
    entity: string,
    entityId: string | null,
    before: unknown,
    after: unknown,
    ip?: string,
  ): Promise<void> {
    await this.prisma.adminAuditLog.create({
      data: {
        adminUserId,
        action,
        entity,
        entityId,
        before: (before ?? null) as never,
        after: (after ?? null) as never,
        ip: ip ?? null,
      },
    });
  }
}
