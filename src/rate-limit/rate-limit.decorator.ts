import { SetMetadata } from '@nestjs/common';
import type { PolicyName } from './policies';

export const RATE_LIMIT_KEY = 'rateLimitPolicy';

/**
 * Which request limit applies (src/rate-limit/policies.ts). On a method or a
 * controller; a method's own wins. A route without one gets `default`.
 */
export const RateLimit = (name: PolicyName) => SetMetadata(RATE_LIMIT_KEY, name);
