import { ReferralRewardKind, ReferralRewardStatus, UserStatus } from '@prisma/client';
import { ReferralsService } from './referrals.service';
import { dec } from '../common/money';

/**
 * L7 (PROJECT_REVIEW): the referral caps were checked before the payment, in a
 * separate step, so two rewards paid at the same moment could both pass and
 * go over the cap. And rewards were paid to suspended users. Both are now
 * checked inside the serializable write that pays.
 */
const tick = () => new Promise((r) => setImmediate(r));

function build(status: UserStatus = UserStatus.ACTIVE) {
  const rewards = [
    { id: 'r1', userId: 'u1', kind: ReferralRewardKind.REFERRER, status: ReferralRewardStatus.PENDING as ReferralRewardStatus, amountNgn: '1000', blockedReason: null as string | null },
    { id: 'r2', userId: 'u1', kind: ReferralRewardKind.REFERRER, status: ReferralRewardStatus.PENDING as ReferralRewardStatus, amountNgn: '1000', blockedReason: null as string | null },
  ];
  const credits: string[] = [];
  const t = {
    user: { findUnique: jest.fn(async () => (await tick(), { status })) },
    referralReward: {
      count: jest.fn(async ({ where }: { where: { status: ReferralRewardStatus } }) => (await tick(), rewards.filter((r) => r.status === where.status).length)),
      aggregate: jest.fn(async () => {
        await tick();
        const sum = rewards.filter((r) => r.status === ReferralRewardStatus.RELEASED).reduce((s, r) => s + Number(r.amountNgn), 0);
        return { _sum: { amountNgn: sum ? dec(sum) : null } };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; status: ReferralRewardStatus }; data: Record<string, unknown> }) => {
        await tick();
        const r = rewards.find((x) => x.id === where.id && x.status === where.status);
        if (!r) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      }),
      update: jest.fn(async () => (await tick(), {})),
    },
    transaction: { create: jest.fn(async () => (await tick(), { id: `tx-${credits.length}` })) },
  };
  // SERIALIZABLE, as observed: one closure at a time.
  let chain: Promise<unknown> = Promise.resolve();
  const serializable = jest.fn((fn: (x: unknown) => Promise<unknown>) => {
    const run = chain.then(() => fn(t));
    chain = run.catch(() => undefined);
    return run;
  });
  const svc = new ReferralsService(
    { ...t, serializable } as never,
    { credit: jest.fn(async (_t: unknown, p: { amount: { toFixed(): string } }) => credits.push(p.amount.toFixed())) } as never,
    { notify: jest.fn(async () => undefined) } as never,
  );
  const pay = (id: string, settings: { maxPaidReferralsPerUser: number; maxEarningsPerUserNgn: string }) =>
    (svc as unknown as { pay: (...a: unknown[]) => Promise<void> }).pay(id, 'u1', dec('1000'), ReferralRewardKind.REFERRER, {
      maxPaidReferralsPerUser: settings.maxPaidReferralsPerUser,
      maxEarningsPerUserNgn: dec(settings.maxEarningsPerUserNgn),
    });
  return { pay, credits, rewards };
}

describe('L7: referral caps hold when two rewards are paid at once', () => {
  it('a limit of 1 paid referral pays exactly one of two simultaneous rewards', async () => {
    const { pay, credits, rewards } = build();
    await Promise.all([pay('r1', { maxPaidReferralsPerUser: 1, maxEarningsPerUserNgn: '0' }), pay('r2', { maxPaidReferralsPerUser: 1, maxEarningsPerUserNgn: '0' })]);
    expect(credits).toHaveLength(1);
    const waiting = rewards.find((r) => r.status === ReferralRewardStatus.PENDING)!;
    expect(waiting.blockedReason).toContain('limit of 1 paid referrals');
  });

  it('a ₦1,500 earnings limit pays exactly one ₦1,000 reward of two', async () => {
    const { pay, credits } = build();
    await Promise.all([pay('r1', { maxPaidReferralsPerUser: 0, maxEarningsPerUserNgn: '1500' }), pay('r2', { maxPaidReferralsPerUser: 0, maxEarningsPerUserNgn: '1500' })]);
    expect(credits).toHaveLength(1);
  });

  it('with no caps, both are paid', async () => {
    const { pay, credits } = build();
    await Promise.all([pay('r1', { maxPaidReferralsPerUser: 0, maxEarningsPerUserNgn: '0' }), pay('r2', { maxPaidReferralsPerUser: 0, maxEarningsPerUserNgn: '0' })]);
    expect(credits).toHaveLength(2);
  });
});

describe('L7: a suspended account is not paid', () => {
  it('the reward stays waiting, with the reason recorded', async () => {
    const { pay, credits, rewards } = build(UserStatus.SUSPENDED);
    await pay('r1', { maxPaidReferralsPerUser: 0, maxEarningsPerUserNgn: '0' });
    expect(credits).toHaveLength(0);
    expect(rewards[0]).toMatchObject({ status: ReferralRewardStatus.PENDING, blockedReason: 'Paused — the account is not active' });
  });
});
