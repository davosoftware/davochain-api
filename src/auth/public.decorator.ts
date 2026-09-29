import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Opt a route out of JwtAuthGuard. Auth is on by default — you opt OUT, never in. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
