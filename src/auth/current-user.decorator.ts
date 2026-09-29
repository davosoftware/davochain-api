import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from './auth.service';

export interface AuthedRequest extends Request {
  user?: JwtPayload;
}

/** Injects the verified JWT payload. Always populated behind JwtAuthGuard. */
export const CurrentUser = createParamDecorator(
  (field: keyof JwtPayload | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user?: JwtPayload }>();
    return field ? req.user?.[field] : req.user;
  },
);
