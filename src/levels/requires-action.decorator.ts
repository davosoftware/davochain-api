import { SetMetadata } from '@nestjs/common';
import { PolicyAction } from '@prisma/client';

export const REQUIRED_ACTION_KEY = 'requiredAction';
/**
 * Gate a route on an admin rule (spec §5.3). 'QUOTE_SIDE' = the quote's
 * body.side picks BUY, SELL or SWAP (or, when carrying out a trade, the side
 * of the stored quote named by body.quoteId).
 */
export const RequiresAction = (action: PolicyAction | 'QUOTE_SIDE') => SetMetadata(REQUIRED_ACTION_KEY, action);
