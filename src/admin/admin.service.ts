import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AdminRole, KycStatus, KycTier } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TemplatedMailService } from '../cms/templated-mail.service';
import { ReferralsService } from '../referrals/referrals.service';
import { PasswordService } from '../auth/password.service';
import { RatesService } from '../rates/rates.service';
import { AdminSessionsService } from './sessions.service';
import { dec, str } from '../common/money';

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
  ) {}

  async login(
    email: string,
    password: string,
    context?: { ip?: string; userAgent?: string },
  ): Promise<{ accessToken: string }> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    if (!admin || !admin.isActive) {
      await this.passwords.dummyVerify();
      throw new UnauthorizedException('Incorrect email or password');
    }
    if (!(await this.passwords.verify(password, admin.passwordHash))) {
      throw new UnauthorizedException('Incorrect email or password');
    }

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    return { accessToken: await this.signToken(admin, context) };
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
    const profile = await this.prisma.kycProfile.findUniqueOrThrow({ where: { userId } });
    const tier = decision.tier ?? KycTier.TIER_1;

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
