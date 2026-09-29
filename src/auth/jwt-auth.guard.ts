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
import { KycStatus, KycTier } from '@prisma/client';
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
 * The JWT carries the tier at issue time, so a token minted before an upgrade
 * still says TIER_0 until it refreshes — deliberate. Approving KYC should also
 * revoke sessions, or the user waits up to the access-token lifetime.
 */
export const RequiresKyc = (tier: KycTier) => SetMetadata(REQUIRED_TIER_KEY, tier);

const TIER_ORDER: Record<KycTier, number> = {
  TIER_0: 0,
  TIER_1: 1,
  TIER_2: 2,
  TIER_3: 3,
};

@Injectable()
export class KycGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<KycTier>(REQUIRED_TIER_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required) return true;

    const req = ctx.switchToHttp().getRequest<{ user?: JwtPayload }>();
    const user = req.user;
    if (!user) throw new UnauthorizedException();

    if (user.kyc !== KycStatus.APPROVED || TIER_ORDER[user.tier] < TIER_ORDER[required]) {
      throw new ForbiddenException({
        message: 'Verification required before you can do this',
        requiredTier: required,
        currentTier: user.tier,
        kycStatus: user.kyc,
      });
    }
    return true;
  }
}
