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
import { KycStatus, KycTier, PolicyAction, PolicyLevel, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { JwtPayload } from './auth.service';
import { LevelPolicyService } from '../levels/level-policy.service';
import { ACTIONS, LEVEL_TITLES, levelOf, lowestLevelAllowing, tierFor } from '../levels/levels';
import { REQUIRED_ACTION_KEY } from '../levels/requires-action.decorator';

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
    private readonly policy: LevelPolicyService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<PolicyAction | 'QUOTE_SIDE'>(REQUIRED_ACTION_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (action) return this.byAdminRules(ctx, action);

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

  /** @RequiresAction: the admin's level rules decide, not a fixed tier (level policy spec §5.3). */
  private async byAdminRules(ctx: ExecutionContext, action: PolicyAction | 'QUOTE_SIDE'): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ user?: JwtPayload; body?: { side?: string; quoteId?: string } }>();
    if (!req.user) throw new UnauthorizedException();
    const u = await this.prisma.user.findUnique({
      where: { id: req.user.sub },
      select: { status: true, kycTier: true, kycStatus: true, amlStatus: true },
    });
    const review = () => new ForbiddenException({ message: GATE_REVIEW, code: 'ACCOUNT_UNDER_REVIEW' });
    if (!u || u.status !== UserStatus.ACTIVE) throw review();
    if (u.amlStatus === 'BLOCKED' || u.amlStatus === 'RESTRICTED' || u.amlStatus === 'UNDER_REVIEW') throw review();

    const resolved = action === 'QUOTE_SIDE' ? await this.quoteSide(req.user.sub, req.body) : action;
    // A level above None counts only once it is approved and screened.
    const verified = u.kycStatus === KycStatus.APPROVED && u.amlStatus === 'CLEAR';
    const level = verified ? levelOf(u.kycTier) : PolicyLevel.NONE;
    const rules = await this.policy.rulesFor(level);
    if (rules.some((r) => r.action === resolved && r.allowed)) return true;
    if (u.kycStatus === KycStatus.APPROVED && u.amlStatus !== 'CLEAR' && u.amlStatus !== 'NOT_SCREENED') {
      throw new ForbiddenException({ message: GATE_PENDING, code: 'VERIFICATION_PENDING' });
    }
    const required = lowestLevelAllowing(await this.policy.allRules(), resolved);
    throw new ForbiddenException({
      code: 'NOT_ALLOWED_AT_LEVEL',
      action: resolved,
      currentLevel: level,
      requiredLevel: required,
      requiredTier: required ? tierFor(required) : null,
      currentTier: u.kycTier,
      kycStatus: u.kycStatus,
      message: required
        ? `Complete ${LEVEL_TITLES[required]} verification to ${ACTIONS[resolved].label}.`
        : `You cannot ${ACTIONS[resolved].label} right now.`,
    });
  }

  /**
   * A quote names its side in the body; carrying one out names only the quote,
   * so its stored side decides. An unknown quote is treated as a buy (fails
   * closed; the route then refuses the quote itself).
   */
  private async quoteSide(userId: string, body?: { side?: string; quoteId?: string }): Promise<PolicyAction> {
    let side = body?.side;
    if (!side && body?.quoteId) {
      const q = await this.prisma.rateQuote.findFirst({ where: { id: body.quoteId, userId }, select: { side: true } });
      side = q?.side.toLowerCase();
    }
    return side === 'sell' ? PolicyAction.SELL : side === 'swap' ? PolicyAction.SWAP : PolicyAction.BUY;
  }
}
