import { GiftCardsController } from './giftcards.controller';
import { REQUIRED_ACTION_KEY } from '../levels/requires-action.decorator';

/**
 * M6 (decision 15 Oct 2026): selling a gift card is gated, like every other
 * way of getting money out of the platform. Which level may do it is now an
 * admin rule (GIFTCARD_SELL); the seed allows Basic.
 */
describe('M6: selling a gift card is gated by the admin rule', () => {
  it('POST /v1/giftcards/trades asks the GIFTCARD_SELL rule', () => {
    expect(Reflect.getMetadata(REQUIRED_ACTION_KEY, GiftCardsController.prototype.submit)).toBe('GIFTCARD_SELL');
  });

  it('browsing the catalogue still needs nothing', () => {
    expect(Reflect.getMetadata(REQUIRED_ACTION_KEY, GiftCardsController.prototype.catalogue)).toBeUndefined();
  });
});
