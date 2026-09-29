import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AdminRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSessionsService } from './sessions.service';
import { PERMISSIONS_KEY } from './require-permissions.decorator';
import type { AdminJwtPayload } from './admin.service';

/**
 * A separate secret and a separate token type. A user token must never be
 * usable against the admin surface, even if it leaks.
 *
 * The signature alone is not enough. A JWT is valid until it expires no matter
 * what happens behind it, so this also asks, on every request:
 *
 *   - is the account still active?
 *   - was the password changed since this token was minted?
 *   - is the session still live, or has it been idle too long?
 *   - does this admin hold the permission this route requires?
 *
 * That is two indexed lookups per request. Admin traffic is measured in
 * requests per minute, and the alternative is a token that outlives the access
 * it represents.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sessions: AdminSessionsService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string>;
      admin?: AdminJwtPayload & { permissions: string[] };
    }>();
    const [scheme, token] = (req.headers['authorization'] ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Missing admin token');
    }

    let payload: AdminJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<AdminJwtPayload>(token, {
        secret: this.config.getOrThrow<string>('ADMIN_JWT_SECRET'),
      });
      if (payload.typ !== 'admin') throw new Error('wrong token type');
    } catch {
      throw new UnauthorizedException('Invalid or expired admin token');
    }

    const admin = await this.prisma.adminUser.findUnique({
      where: { id: payload.sub },
      select: { isActive: true, passwordChangedAt: true, role: true, permissions: true },
    });

    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('This account is no longer active');
    }

    // Compared in whole seconds because that is all `iat` carries. A token
    // minted in the same second as the change survives, which is exactly the
    // replacement token handed back by a password change.
    const changedAt = Math.floor(admin.passwordChangedAt.getTime() / 1000);
    if ((payload.iat ?? 0) < changedAt) {
      throw new UnauthorizedException('Your password changed. Please sign in again.');
    }

    // Tokens minted before sessions existed carry no jti. Refusing them signs
    // everyone out once, which is the correct migration for a security change.
    if (!payload.jti) {
      throw new UnauthorizedException('Please sign in again');
    }

    const session = await this.sessions.touch(payload.jti);
    if (!session.ok) {
      throw new UnauthorizedException(
        session.reason === 'idle'
          ? 'Signed out after a period of inactivity. Please sign in again.'
          : 'Your session has ended. Please sign in again.',
      );
    }

    req.admin = { ...payload, role: admin.role, permissions: admin.permissions };

    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (required && required.length > 0 && admin.role !== AdminRole.OWNER) {
      const missing = required.filter((p) => !admin.permissions.includes(p));
      if (missing.length > 0) {
        // Name what is missing: a sub-admin hitting a wall should be able to
        // tell the owner exactly what to grant.
        throw new ForbiddenException(
          `You do not have permission to do this. Missing: ${missing.join(', ')}`,
        );
      }
    }

    return true;
  }
}
