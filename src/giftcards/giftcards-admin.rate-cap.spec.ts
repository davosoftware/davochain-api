import { BadRequestException } from '@nestjs/common';
import { GiftCardsAdminService } from './giftcards-admin.service';

/**
 * M6 (PROJECT_REVIEW): partially approving a gift card took any rate the
 * reviewer typed, with no upper bound: ₦1,000,000 per $1 to a friend was one
 * form away. The rate paid can now never be above the rate the customer was
 * quoted.
 */
function build() {
  const svc = Object.create(GiftCardsAdminService.prototype) as GiftCardsAdminService;
  const settle = jest.fn(async () => ({ ok: true }));
  Object.assign(svc, {
    prisma: {
      giftCardTrade: {
        findUnique: jest.fn(async () => ({ id: 'g1', userId: 'u1', status: 'PENDING', faceValue: '100', currency: 'USD', rateNgn: '1200' })),
      },
    },
    settle,
  });
  return { svc, settle };
}
const input = (approvedRateNgn: string) => ({ approvedValue: '60', approvedRateNgn, actualRateNgn: '1250', reason: 'Half spent' });

describe('M6: a partial gift-card approval never pays above the quoted rate', () => {
  it('a rate above the quoted ₦1,200 is refused', async () => {
    const { svc, settle } = build();
    const err = await svc.partiallyApprove('a1', 'g1', input('1000000')).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('The rate cannot be above the ₦1200.00 quoted to the customer.');
    expect(settle).not.toHaveBeenCalled();
  });

  it('the quoted rate, or less, is accepted', async () => {
    const { svc, settle } = build();
    await svc.partiallyApprove('a1', 'g1', input('1200'));
    await svc.partiallyApprove('a1', 'g1', input('1100'));
    expect(settle).toHaveBeenCalledTimes(2);
  });
});
