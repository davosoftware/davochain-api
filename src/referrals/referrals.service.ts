import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import {
  KycTier,
  LedgerAccount,
  Prisma,
  ReferralRewardKind,
  ReferralRewardStatus,
  ReferralStatus,
  TxStatus,
  TxType,
  UserStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Decimal, ZERO, dec, str } from '../common/money';
import {
  checkUsername,
  generateReferralCode,
  normaliseCode,
  referralLink,
} from './referral-code';

/** Tiers in order, so "at least TIER_2" is a comparison rather than a list. */
const TIER_ORDER: KycTier[] = [KycTier.TIER_0, KycTier.TIER_1, KycTier.TIER_2, KycTier.TIER_3];

function tierAtLeast(has: KycTier, needs: KycTier): boolean {
  return TIER_ORDER.indexOf(has) >= TIER_ORDER.indexOf(needs);
}

/** What the trade-volume threshold counts. Money in and out is not trading. */
const VOLUME_TYPES: TxType[] = [TxType.BUY, TxType.SELL, TxType.SWAP];

export interface ReferralSettingsView {
  isEnabled: boolean;
  referrerRewardNgn: string;
  refereeRewardNgn: string;
  unlockTier: KycTier;
  refereeTradeVolumeNgn: string;
  maxPaidReferralsPerUser: number;
  maxEarningsPerUserNgn: string;
  headline: string;
  terms: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

@Injectable()
export class ReferralsService {
  private readonly log = new Logger(ReferralsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── settings ──────────────────────────────────────────────

  /**
   * The programme's terms, creating the row on first read.
   *
   * Defaults are all zero and `isEnabled` false, so an install that has never
   * been configured pays nothing rather than paying a default somebody forgot
   * to change.
   */
  async settings() {
    return this.prisma.referralSetting.upsert({
      where: { id: 'default' },
      create: { id: 'default' },
      update: {},
    });
  }

  view(s: Awaited<ReturnType<ReferralsService['settings']>>): ReferralSettingsView {
    return {
      isEnabled: s.isEnabled,
      referrerRewardNgn: str(s.referrerRewardNgn, 2),
      refereeRewardNgn: str(s.refereeRewardNgn, 2),
      unlockTier: s.unlockTier,
      refereeTradeVolumeNgn: str(s.refereeTradeVolumeNgn, 2),
      maxPaidReferralsPerUser: s.maxPaidReferralsPerUser,
      maxEarningsPerUserNgn: str(s.maxEarningsPerUserNgn, 2),
      headline: s.headline,
      terms: s.terms,
      updatedAt: s.updatedAt.toISOString(),
      updatedBy: s.updatedBy,
    };
  }

  /**
   * Where the public site lives, for building links.
   *
   * Read straight from the settings row rather than through SiteSettingsService,
   * which would make this module depend on the admin module — and the admin
   * module already needs this one, to release a reward when a KYC is approved.
   * One column is not worth a circular import.
   */
  private async websiteUrl(): Promise<string> {
    const row = await this.prisma.siteSetting.findUnique({
      where: { id: 'default' },
      select: { websiteUrl: true },
    });
    return row?.websiteUrl ?? 'https://davochain.com';
  }

  // ── codes ─────────────────────────────────────────────────

  /**
   * The code somebody shares. Generated on first use, then kept.
   *
   * Not written at registration: a referral code is worth nothing until
   * somebody looks at it, and generating one inside the signup transaction
   * would put a retry loop on the critical path of creating an account.
   */
  async codeFor(userId: string): Promise<string> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { firstName: true, referralCode: true, username: true },
    });
    if (user.username) return user.username;
    if (user.referralCode) return user.referralCode;

    // Collisions are rare but real; the unique index is the actual guarantee,
    // so this retries on it rather than checking first and hoping.
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = generateReferralCode(user.firstName);
      try {
        await this.prisma.user.update({
          where: { id: userId },
          data: { referralCode: candidate },
        });
        return candidate;
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') continue;
        throw err;
      }
    }
    throw new ConflictException('Could not allocate a referral code. Try again.');
  }

  /**
   * Whose code is this?
   *
   * A username REPLACES the generated code, so a generated code only resolves
   * while its owner has not chosen one. Otherwise retiring a code would still
   * leave it working, and "replaces" would not mean anything.
   */
  async resolve(rawCode: string): Promise<{ id: string; firstName: string } | null> {
    const code = normaliseCode(rawCode);
    if (!code) return null;

    return this.prisma.user.findFirst({
      where: {
        status: UserStatus.ACTIVE,
        OR: [{ username: code }, { referralCode: code, username: null }],
      },
      select: { id: true, firstName: true },
    });
  }

  /**
   * Claim a username, retiring the generated code.
   *
   * Once, and only once.
   *
   * Changing it a second time would free the old one for somebody else to
   * take, and a link that has already been shared, printed or forwarded would
   * quietly start paying a different person. That is the failure this whole
   * design exists to avoid, so the endpoint refuses rather than the screen
   * merely hiding the button.
   */
  async setUsername(userId: string, input: string): Promise<{ code: string }> {
    const verdict = checkUsername(input);
    if (!verdict.ok) throw new BadRequestException(verdict.reason!);

    const current = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { username: true },
    });
    if (current.username) {
      throw new ConflictException(
        `Your username is already ${current.username} and cannot be changed — links you have shared point at it.`,
      );
    }

    const taken = await this.prisma.user.findFirst({
      where: {
        NOT: { id: userId },
        OR: [{ username: verdict.value }, { referralCode: verdict.value }],
      },
      select: { id: true },
    });
    if (taken) throw new ConflictException('That username is taken. Try another.');

    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { username: verdict.value },
      });
    } catch (err) {
      // Somebody claimed it between the check and the write.
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException('That username was just taken. Try another.');
      }
      throw err;
    }
    return { code: verdict.value };
  }

  // ── signing up with a code ────────────────────────────────

  /**
   * Attach a referrer to a brand-new account.
   *
   * Called from registration, inside no transaction of its own: a referral
   * that fails to record must never fail the signup. Somebody who cannot
   * create an account because a promotion misbehaved is a customer lost for a
   * reason that has nothing to do with them.
   *
   * Both amounts are copied from settings AS THEY STAND NOW and stored on the
   * reward rows. Changing the offer next week does not reprice what these two
   * people were promised.
   */
  async attach(refereeId: string, rawCode: string): Promise<void> {
    const settings = await this.settings();
    if (!settings.isEnabled) return;

    const code = normaliseCode(rawCode);
    if (!code) return;

    const referrer = await this.resolve(code);
    if (!referrer) {
      this.log.warn(`Signup used referral code ${code}, which matches nobody`);
      return;
    }
    // The one guard that cannot be a setting.
    if (referrer.id === refereeId) return;

    try {
      await this.prisma.referral.create({
        data: {
          referrerId: referrer.id,
          refereeId,
          codeUsed: code,
          rewards: {
            create: [
              {
                userId: referrer.id,
                kind: ReferralRewardKind.REFERRER,
                amountNgn: settings.referrerRewardNgn,
                blockedReason: `Waiting for them to reach ${settings.unlockTier.replace('_', ' ')}`,
              },
              {
                userId: refereeId,
                kind: ReferralRewardKind.REFEREE,
                amountNgn: settings.refereeRewardNgn,
                blockedReason: this.refereeBlockedReason(settings, ZERO),
              },
            ],
          },
        },
      });
    } catch (err) {
      // refereeId is unique: an account can be referred exactly once, and a
      // retried signup must not create a second referral.
      if ((err as { code?: string }).code === 'P2002') return;
      throw err;
    }
  }

  private refereeBlockedReason(
    settings: { unlockTier: KycTier; refereeTradeVolumeNgn: Prisma.Decimal },
    traded: Decimal,
  ): string {
    const tier = settings.unlockTier.replace('_', ' ');
    const needed = dec(settings.refereeTradeVolumeNgn);
    if (needed.lte(0)) return `Complete ${tier} verification to unlock`;
    return `Complete ${tier} verification and trade ₦${str(needed, 2)} to unlock — ₦${str(traded, 2)} so far`;
  }

  // ── releasing ─────────────────────────────────────────────

  /**
   * Pay whatever this user has now earned, and update what has not.
   *
   * Idempotent and safe to call as often as anything likes — it is invoked
   * when KYC is approved, when a trade completes, and whenever the referral
   * screen is opened. A reward moves to RELEASED exactly once because the
   * update is conditional on it still being PENDING.
   *
   * Never throws at the caller. This runs on the back of somebody else's
   * successful action — a KYC approval, a completed trade — and a promotion
   * that cannot pay must not turn one of those into a failure.
   */
  async evaluate(userId: string): Promise<void> {
    try {
      await this.release(userId);
    } catch (err) {
      this.log.error(`Referral evaluation failed for ${userId}: ${(err as Error).message}`);
    }
  }

  private async release(userId: string): Promise<void> {
    const settings = await this.settings();

    const pending = await this.prisma.referralReward.findMany({
      where: { userId, status: ReferralRewardStatus.PENDING },
      include: { referral: { include: { referee: { select: { id: true, kycTier: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
    if (pending.length === 0) return;

    for (const reward of pending) {
      const referee = reward.referral.referee;
      const tierMet = tierAtLeast(referee.kycTier, settings.unlockTier);

      if (!tierMet) {
        await this.note(
          reward.id,
          `Waiting for them to reach ${settings.unlockTier.replace('_', ' ')}`,
        );
        continue;
      }

      /*
       * The referrer is paid on the referee's verification alone. Making them
       * wait for somebody else's trading would make the reward depend on a
       * thing they cannot influence or even see.
       */
      if (reward.kind === ReferralRewardKind.REFEREE) {
        const needed = dec(settings.refereeTradeVolumeNgn);
        if (needed.gt(0)) {
          const traded = await this.tradedNgn(userId);
          if (traded.lt(needed)) {
            await this.note(reward.id, this.refereeBlockedReason(settings, traded));
            continue;
          }
        }
      }

      const cap = await this.capCheck(userId, dec(reward.amountNgn), settings);
      if (cap) {
        await this.note(reward.id, cap);
        continue;
      }

      await this.pay(reward.id, userId, dec(reward.amountNgn), reward.kind);
    }

    await this.completeReferrals(userId);
  }

  /** What this user has traded, in naira, ever. Buys, sells and swaps only. */
  private async tradedNgn(userId: string): Promise<Decimal> {
    /*
     * Priced in naira through the gate that was live at the time, because that
     * is the figure the threshold is expressed in. usdValue times gateApplied
     * is the same reconstruction the earnings manager uses, so a user's
     * progress and the platform's books are reading one number.
     */
    const rows = await this.prisma.$queryRaw<{ total: Prisma.Decimal | null }[]>`
      SELECT COALESCE(SUM("usdValue" * "gateApplied"), 0) AS total
      FROM "transactions"
      WHERE "userId" = ${userId}
        AND "status" = 'COMPLETED'
        AND "type" = ANY(${VOLUME_TYPES}::"TxType"[])
        AND "usdValue" IS NOT NULL
        AND "gateApplied" IS NOT NULL
    `;
    return dec(rows[0]?.total ?? 0);
  }

  /**
   * Whether a cap stops this payment, and which one.
   *
   * Both caps PAUSE rather than end: the reward stays PENDING with the reason
   * on it, so raising the cap later lets it through without anybody having to
   * find and repair the rows that were refused.
   */
  private async capCheck(
    userId: string,
    amount: Decimal,
    settings: { maxPaidReferralsPerUser: number; maxEarningsPerUserNgn: Prisma.Decimal },
  ): Promise<string | null> {
    if (settings.maxPaidReferralsPerUser > 0) {
      const paid = await this.prisma.referralReward.count({
        where: {
          userId,
          kind: ReferralRewardKind.REFERRER,
          status: ReferralRewardStatus.RELEASED,
        },
      });
      if (paid >= settings.maxPaidReferralsPerUser) {
        return `Paused — you have reached the limit of ${settings.maxPaidReferralsPerUser} paid referrals`;
      }
    }

    const ceiling = dec(settings.maxEarningsPerUserNgn);
    if (ceiling.gt(0)) {
      const earned = await this.earnedNgn(userId);
      if (earned.plus(amount).gt(ceiling)) {
        return `Paused — this would take you past the ₦${str(ceiling, 2)} referral limit (₦${str(earned, 2)} earned so far)`;
      }
    }
    return null;
  }

  private async earnedNgn(userId: string): Promise<Decimal> {
    const r = await this.prisma.referralReward.aggregate({
      where: { userId, status: ReferralRewardStatus.RELEASED },
      _sum: { amountNgn: true },
    });
    return r._sum.amountNgn ? dec(r._sum.amountNgn) : ZERO;
  }

  /** Record why a reward is still waiting, without touching its status. */
  private async note(rewardId: string, reason: string): Promise<void> {
    await this.prisma.referralReward.updateMany({
      where: { id: rewardId, status: ReferralRewardStatus.PENDING },
      data: { blockedReason: reason },
    });
  }

  /**
   * Turn a promise into naira.
   *
   * One serializable write: a DEPOSIT transaction so it appears in their
   * history, the ledger entry that moves the money out of PROMOTION and into
   * their balance, and the reward marked RELEASED. All three or none — a
   * credit without a reward row would pay twice on the next run.
   *
   * The reward update is conditional on PENDING, so two evaluations racing
   * each other still pay once.
   */
  private async pay(
    rewardId: string,
    userId: string,
    amount: Decimal,
    kind: ReferralRewardKind,
  ): Promise<void> {
    if (amount.lte(0)) {
      // Nothing to pay, but it is settled: leaving it PENDING forever would
      // put a permanent "waiting" line on a screen for a zero-value offer.
      await this.prisma.referralReward.updateMany({
        where: { id: rewardId, status: ReferralRewardStatus.PENDING },
        data: {
          status: ReferralRewardStatus.RELEASED,
          releasedAt: new Date(),
          blockedReason: null,
        },
      });
      return;
    }

    const paid = await this.prisma.serializable(async (t) => {
      const claimed = await t.referralReward.updateMany({
        where: { id: rewardId, status: ReferralRewardStatus.PENDING },
        data: { status: ReferralRewardStatus.RELEASED, releasedAt: new Date() },
      });
      // Somebody else got there first. Nothing to do, and nothing to undo.
      if (claimed.count === 0) return false;

      const tx = await t.transaction.create({
        data: {
          userId,
          type: TxType.DEPOSIT,
          status: TxStatus.COMPLETED,
          toAsset: 'ngn',
          toAmount: amount.toFixed(),
          reference: `referral_${rewardId}`,
          completedAt: new Date(),
        },
      });

      await this.ledger.credit(t, {
        userId,
        assetCode: 'ngn',
        amount,
        // Not EXTERNAL: nobody outside sent this. We gave it away to win a
        // customer, and the books should be able to say how much that cost.
        counterparty: LedgerAccount.PROMOTION,
        transactionId: tx.id,
        memo: `referral reward (${kind.toLowerCase()})`,
      });

      await t.referralReward.update({
        where: { id: rewardId },
        data: { transactionId: tx.id, blockedReason: null },
      });
      return true;
    });

    if (!paid) return;

    await this.notifications.notify({
      userId,
      type: 'deposit.credited',
      title: `₦${str(amount, 2)} referral reward`,
      body:
        kind === ReferralRewardKind.REFERRER
          ? 'Someone you invited completed their verification. Your reward is in your naira balance.'
          : 'Your referral bonus has been added to your naira balance.',
    });
    this.log.log(`Referral reward ${rewardId} released: ₦${str(amount, 2)} to ${userId}`);
  }

  /**
   * A referral is COMPLETED once the person who shared the code has been paid.
   *
   * That is the event the badge is about — it is the referrer's screen it
   * appears on, and their question is "did this one count?".
   */
  private async completeReferrals(userId: string): Promise<void> {
    const done = await this.prisma.referralReward.findMany({
      where: {
        userId,
        kind: ReferralRewardKind.REFERRER,
        status: ReferralRewardStatus.RELEASED,
        referral: { status: ReferralStatus.PENDING },
      },
      select: { referralId: true },
    });
    if (done.length === 0) return;

    await this.prisma.referral.updateMany({
      where: { id: { in: done.map((d) => d.referralId) }, status: ReferralStatus.PENDING },
      data: { status: ReferralStatus.COMPLETED, completedAt: new Date() },
    });
  }

  // ── what a user sees ──────────────────────────────────────

  /**
   * The whole referral screen in one call.
   *
   * Evaluates first, so opening the screen is also the safety net: if a
   * release was ever missed — a webhook that never arrived, a worker that
   * died — looking at the page pays it.
   *
   * Pending rewards are reported here and NOWHERE else. They are not in the
   * naira balance, not in the transaction history, and not in any total the
   * wallet shows, because they are not money yet. This screen is the one place
   * that knows about a promise.
   */
  async dashboard(userId: string) {
    await this.evaluate(userId);

    const [settings, baseUrl, code, user, referrals, rewards] = await Promise.all([
      this.settings(),
      this.websiteUrl(),
      this.codeFor(userId),
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { username: true, kycTier: true },
      }),
      this.prisma.referral.findMany({
        where: { referrerId: userId },
        include: {
          referee: { select: { firstName: true, lastName: true, kycTier: true, createdAt: true } },
          rewards: { where: { kind: ReferralRewardKind.REFERRER } },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.prisma.referralReward.findMany({
        where: { userId },
        select: { kind: true, status: true, amountNgn: true, blockedReason: true, releasedAt: true },
      }),
    ]);

    const sum = (rows: typeof rewards) =>
      rows.reduce((total, r) => total.plus(dec(r.amountNgn)), ZERO);

    const released = rewards.filter((r) => r.status === ReferralRewardStatus.RELEASED);
    const waiting = rewards.filter((r) => r.status === ReferralRewardStatus.PENDING);
    /* Their own signup bonus, which is the figure they came looking for. */
    const ownBonus = waiting.find((r) => r.kind === ReferralRewardKind.REFEREE);

    return {
      code,
      link: referralLink(baseUrl, code),
      username: user.username,
      /* One change only. A retired code has to stay retired, or a link
         somebody already shared starts pointing at a different person. */
      canSetUsername: user.username === null,

      offer: {
        isEnabled: settings.isEnabled,
        headline: settings.headline,
        terms: settings.terms,
        /** What a friend gets for signing up with this code. */
        theyGetNgn: str(settings.refereeRewardNgn, 2),
        /** What this user gets when that friend verifies. */
        youGetNgn: str(settings.referrerRewardNgn, 2),
        unlockTier: settings.unlockTier,
        tradeVolumeNgn: str(settings.refereeTradeVolumeNgn, 2),
      },

      totals: {
        /** In the naira balance already. Ordinary money. */
        earnedNgn: str(sum(released), 2),
        /** Promised, conditions unmet. Deliberately not in any balance. */
        pendingNgn: str(sum(waiting), 2),
        referrals: referrals.length,
        completed: referrals.filter((r) => r.status === ReferralStatus.COMPLETED).length,
      },

      /** The signup bonus this user is owed, if they arrived through a code. */
      signupBonus: ownBonus
        ? { amountNgn: str(dec(ownBonus.amountNgn), 2), blockedReason: ownBonus.blockedReason }
        : null,

      referrals: referrals.map((r) => {
        const reward = r.rewards[0];
        return {
          name: `${r.referee.firstName} ${r.referee.lastName}`.trim(),
          joinedAt: r.referee.createdAt.toISOString(),
          /* The badge. Completed means this one has been paid; pending means
             it has not, and `note` says what it is waiting for. */
          status: r.status === ReferralStatus.COMPLETED ? 'completed' : 'pending',
          amountNgn: reward ? str(dec(reward.amountNgn), 2) : '0.00',
          note: reward?.status === ReferralRewardStatus.RELEASED ? null : (reward?.blockedReason ?? null),
        };
      }),
    };
  }

  // ── what an admin sees and sets ───────────────────────────

  /**
   * Change the offer.
   *
   * Nothing here touches a reward that already exists. Both amounts were
   * copied onto the reward rows when they were promised, so raising or
   * lowering the figures changes what the NEXT signup is offered and nothing
   * else. The caps are the exception by design — they are evaluated at payout,
   * so raising one releases rewards that were paused under the old ceiling.
   */
  async updateSettings(
    adminId: string,
    changes: Partial<{
      isEnabled: boolean;
      referrerRewardNgn: string;
      refereeRewardNgn: string;
      unlockTier: KycTier;
      refereeTradeVolumeNgn: string;
      maxPaidReferralsPerUser: number;
      maxEarningsPerUserNgn: string;
      headline: string;
      terms: string | null;
    }>,
  ) {
    for (const [field, value] of [
      ['referrerRewardNgn', changes.referrerRewardNgn],
      ['refereeRewardNgn', changes.refereeRewardNgn],
      ['refereeTradeVolumeNgn', changes.refereeTradeVolumeNgn],
      ['maxEarningsPerUserNgn', changes.maxEarningsPerUserNgn],
    ] as const) {
      if (value !== undefined && dec(value).lt(0)) {
        throw new BadRequestException(`${field} cannot be negative`);
      }
    }
    if (changes.maxPaidReferralsPerUser !== undefined && changes.maxPaidReferralsPerUser < 0) {
      throw new BadRequestException('maxPaidReferralsPerUser cannot be negative');
    }

    await this.settings();
    return this.prisma.referralSetting.update({
      where: { id: 'default' },
      data: { ...changes, updatedBy: adminId },
    });
  }

  /**
   * Every referral, for the manager screen.
   *
   * One query for the page and one grouped query for the rewards, rather than
   * a rewards lookup per row — the whole point of the screen is to scan a lot
   * of them at once.
   */
  async adminList(query: {
    status?: ReferralStatus;
    search?: string;
    page?: number;
    pageSize?: number;
  }) {
    const pageSize = Math.min(Math.max(query.pageSize ?? 25, 1), 200);
    const page = Math.max(query.page ?? 1, 1);

    const term = query.search?.trim();
    const like = term ? term.replace(/[\\%_]/g, (c) => `\\${c}`) : null;
    const person = like
      ? {
          OR: [
            { email: { contains: like, mode: Prisma.QueryMode.insensitive } },
            { firstName: { contains: like, mode: Prisma.QueryMode.insensitive } },
            { lastName: { contains: like, mode: Prisma.QueryMode.insensitive } },
          ],
        }
      : undefined;

    const where: Prisma.ReferralWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(person || like
        ? {
            OR: [
              ...(person ? [{ referrer: person }, { referee: person }] : []),
              ...(like ? [{ codeUsed: { contains: like, mode: Prisma.QueryMode.insensitive } }] : []),
            ],
          }
        : {}),
    };

    const select = { firstName: true, lastName: true, email: true, kycTier: true };
    const [rows, total, totals] = await Promise.all([
      this.prisma.referral.findMany({
        where,
        include: {
          referrer: { select },
          referee: { select },
          rewards: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.referral.count({ where }),
      this.prisma.referralReward.groupBy({
        by: ['status'],
        _sum: { amountNgn: true },
        _count: { _all: true },
      }),
    ]);

    const bucket = (status: ReferralRewardStatus) =>
      totals.find((t) => t.status === status);

    return {
      rows: rows.map((r) => {
        const forReferrer = r.rewards.find((x) => x.kind === ReferralRewardKind.REFERRER);
        const forReferee = r.rewards.find((x) => x.kind === ReferralRewardKind.REFEREE);
        const name = (u: { firstName: string; lastName: string }) =>
          `${u.firstName} ${u.lastName}`.trim();

        return {
          id: r.id,
          codeUsed: r.codeUsed,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          completedAt: r.completedAt?.toISOString() ?? null,
          referrer: { name: name(r.referrer), email: r.referrer.email },
          referee: {
            name: name(r.referee),
            email: r.referee.email,
            kycTier: r.referee.kycTier,
          },
          referrerReward: forReferrer
            ? {
                amountNgn: str(dec(forReferrer.amountNgn), 2),
                status: forReferrer.status,
                blockedReason: forReferrer.blockedReason,
                releasedAt: forReferrer.releasedAt?.toISOString() ?? null,
              }
            : null,
          refereeReward: forReferee
            ? {
                amountNgn: str(dec(forReferee.amountNgn), 2),
                status: forReferee.status,
                blockedReason: forReferee.blockedReason,
                releasedAt: forReferee.releasedAt?.toISOString() ?? null,
              }
            : null,
        };
      }),
      page,
      pageSize,
      total,
      /* What the programme has cost and what it still owes. Never added
         together: one is money that has gone, the other is money that may
         never go at all. */
      totals: {
        paidNgn: str(dec(bucket(ReferralRewardStatus.RELEASED)?._sum.amountNgn ?? 0), 2),
        paidCount: bucket(ReferralRewardStatus.RELEASED)?._count._all ?? 0,
        pendingNgn: str(dec(bucket(ReferralRewardStatus.PENDING)?._sum.amountNgn ?? 0), 2),
        pendingCount: bucket(ReferralRewardStatus.PENDING)?._count._all ?? 0,
      },
    };
  }

  /**
   * Everything that has to happen when a referee's tier changes.
   *
   * The referrer's reward hangs on somebody else's verification, so approving
   * a KYC has to evaluate two people, not one.
   */
  async onKycChanged(refereeId: string): Promise<void> {
    const referral = await this.prisma.referral.findUnique({
      where: { refereeId },
      select: { referrerId: true },
    });
    await this.evaluate(refereeId);
    if (referral) await this.evaluate(referral.referrerId);
  }
}
