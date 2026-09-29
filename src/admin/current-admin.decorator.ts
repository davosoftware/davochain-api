import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AdminJwtPayload } from './admin.service';

export const CurrentAdmin = createParamDecorator(
  (field: keyof AdminJwtPayload | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ admin?: AdminJwtPayload }>();
    return field ? req.admin?.[field] : req.admin;
  },
);
