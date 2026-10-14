import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { KycStatus, KycTier, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { JwtPayload } from './auth.service';

/**
 * Auth is on by default across the whole API — a route opts OUT with @Public().
 * A forgotten decorator then fails closed, which is the only safe direction for
 * endpoints that move money.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: JwtPayload }>();
    const header = req.headers['authorization'] ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
      });
      if (payload.typ !== 'access') throw new Error('wrong token type');
      req.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

// ── KYC gating ────────────────────────────────────────────────

export const REQUIRED_TIER_KEY = 'requiredTier';

/**
 * Gate an action behind a verification tier.
 *
 * The tier, KYC status and AML status are read from the database on every
 * gated request, never from the token, so a block or an approval takes effect
 * at once (spec §7.3). Approving KYC still revokes sessions, so the app's own
 * view of the tier catches up.
 */
export const RequiresKyc = (tier: KycTier) => SetMetadata(REQUIRED_TIER_KEY, tier);

export const GATE_VERIFY = 'Verification required before you can do this';
export const GATE_PENDING = 'Your verification is still being completed.';
/** The same words for every reason, so nobody is tipped off (spec §9.2). */
export const GATE_REVIEW = 'Your account is under review. Contact support.';

const TIER_ORDER: Record<KycTier, number> = {
  TIER_0: 0,
  TIER_1: 1,
  TIER_2: 2,
  TIER_3: 3,
};

/**
 * Trade, crypto and naira withdrawals: approved identity at the required tier
 * AND amlStatus CLEAR AND an active account.
 */
@Injectable()
export class KycGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<KycTier>(REQUIRED_TIER_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required) return true;

    const req = ctx.switchToHttp().getRequest<{ user?: JwtPayload }>();
    if (!req.user) throw new UnauthorizedException();

    const u = await this.prisma.user.findUnique({
      where: { id: req.user.sub },
      select: { status: true, kycTier: true, kycStatus: true, amlStatus: true },
    });
    const review = () => new ForbiddenException({ message: GATE_REVIEW, code: 'ACCOUNT_UNDER_REVIEW' });
    if (!u || u.status !== UserStatus.ACTIVE) throw review();
    if (u.amlStatus === 'BLOCKED' || u.amlStatus === 'RESTRICTED' || u.amlStatus === 'UNDER_REVIEW') throw review();
    if (u.kycStatus !== KycStatus.APPROVED || TIER_ORDER[u.kycTier] < TIER_ORDER[required] || u.amlStatus === 'NOT_SCREENED') {
      // The fields the app opens the verification screen on (FLUTTER_API.md §1).
      throw new ForbiddenException({ message: GATE_VERIFY, requiredTier: required, currentTier: u.kycTier, kycStatus: u.kycStatus });
    }
    if (u.amlStatus !== 'CLEAR') throw new ForbiddenException({ message: GATE_PENDING, code: 'VERIFICATION_PENDING' });
    return true;
  }
}
