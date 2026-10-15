import { ForbiddenException } from '@nestjs/common';
import { PolicyAction } from '@prisma/client';
import { WithdrawalsService } from './withdrawals.service';
import { dec } from '../common/money';

describe('Crypto withdrawals obey the level rules', () => {
  function build(opts: { cooling?: boolean }) {
    const policy = {
      fx: jest.fn(async () => ({ ngnPerUsd: dec('1500') })),
      assertCooledOff: jest.fn(async () => { if (opts.cooling) throw new ForbiddenException({ code: 'COOLING_OFF' }); }),
      assertWithinLimits: jest.fn(async () => undefined),
    };
    const svc = Object.create(WithdrawalsService.prototype) as Record<string, unknown>;
    Object.assign(svc, {
      policy,
      flags: { assertWithdrawalsAllowed: jest.fn(async () => undefined) },
      prisma: { user: { findUnique: jest.fn(async () => ({ id: 'u1', kycTier: 'TIER_1', createdAt: new Date(0), credentialsChangedAt: null })) } },
    });
    return { svc, policy };
  }

  it('cooling off: refused before anything is checked or locked', async () => {
    const { svc, policy } = build({ cooling: true });
    await expect((svc.withdrawCrypto as (...a: unknown[]) => Promise<unknown>).call(svc, 'u1', { asset: 'btc', network: 'btc', amount: '0.01', address: 'x' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(policy.assertCooledOff).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), PolicyAction.CRYPTO_WITHDRAW);
  });
});
