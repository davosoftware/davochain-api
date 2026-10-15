import { KycTier } from '@prisma/client';
import { GiftCardsController } from './giftcards.controller';
import { REQUIRED_TIER_KEY } from '../auth/jwt-auth.guard';

/**
 * M6 (decision 15 Oct 2026): selling a gift card needs Basic verification,
 * like every other way of getting money out of the platform. It needed
 * nothing, which matters for anti-money-laundering.
 */
describe('M6: selling a gift card needs Basic verification', () => {
  it('POST /v1/giftcards/trades requires Basic (TIER_1)', () => {
    expect(Reflect.getMetadata(REQUIRED_TIER_KEY, GiftCardsController.prototype.submit)).toBe(KycTier.TIER_1);
  });

  it('browsing the catalogue still needs nothing', () => {
    expect(Reflect.getMetadata(REQUIRED_TIER_KEY, GiftCardsController.prototype.catalogue)).toBeUndefined();
  });
});
