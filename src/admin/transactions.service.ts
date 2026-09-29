import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { LedgerAccount, Prisma, TxStatus, TxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { KycLimitsService } from '../kyc/kyc-limits.service';
import { Decimal, ZERO, dec, str } from '../common/money';
import { escapeLike } from './earnings.service';

/**
 * Which tab a row belongs to.
 *
 * One per transaction type, plus the queue of things waiting on a person.
 * APPROVAL is not a type — it is a state that a deposit gets stuck in — but it
 * earns a tab because it is the only view on this screen where somebody has to
 * do something rather than look at something.
 */
export type TxTab = 'ALL' | 'BUY' | 'SELL' | 'SWAP' | 'DEPOSIT' | 'WITHDRAWAL' | 'APPROVAL';

/** Which way the money went, from the user's side. */
export type AmountType = 'DEBIT' | 'CREDIT';

export interface TxQuery {
  tab?: TxTab;
  status?: TxStatus;
  type?: TxType;
  amountType?: AmountType;
  /** The derived mode of payment — 'BANK' | 'NGN_BALANCE' | 'CHAIN' | 'INTERNAL'. */
  mode?: string;
  search?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
  direction?: 'asc' | 'desc';
}

export interface TxLeg {
  kind: string;
  state: string;
  amount: string;
  reference: string;
  lastError: string | null;
}

export interface TxRow {
  id: string;
  reference: string;
  type: TxType;
  status: TxStatus;
  amountType: AmountType;

  /**
   * The three money columns, and the single unit all three are in.
   *
   * A transaction has two sides in two different assets, so there is no one
   * currency for a row — but there is one currency for the FEE, and that is the
   * side the three figures are stated in. A buy is priced in the naira that
   * left, a swap in the dollars it was quoted at, a crypto withdrawal in the
   * coin that was sent. `unit` says which, on every row.
   */
  unit: string;
  total: string;
  amount: string;
  fee: string;

  /** What the chain took on a withdrawal. A cost, never revenue. */
  networkFee: string | null;

  mode: string;
  modeLabel: string;
  fromAsset: string | null;
  toAsset: string | null;
  fromAmount: string | null;
  toAmount: string | null;

  settledFrom: string | null;
  quidaxRawStatus: string | null;
  failureReason: string | null;
  legs: TxLeg[];

  userId: string;
  name: string;
  email: string;
  createdAt: string;
  completedAt: string | null;

  /** True when this row is a naira deposit waiting on a person. */
  needsApproval: boolean;

  /**
   * Whether releasing this held deposit would now be inside the depositor's
   * limits — asked fresh, against their tier and today's caps as they stand.
   *
   * Null on anything that is not waiting for approval. True means the reason it
   * was held has gone away: their tier was raised, or the cap itself was, and
   * an admin can let it through without overriding anything. It does NOT
   * release it — nothing moves money without somebody deciding to.
   */
  withinLimitsNow: boolean | null;
  /** Why it still would not be allowed, when it would not. */
  limitReason: string | null;

  /** Who released or rejected it, from the audit log. Null until somebody has. */
  reviewedBy: string | null;
  reviewedAt: string | null;
}

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 200;

/** Money leaves the user on these; it arrives on the rest. */
const DEBITS = new Set<TxType>([TxType.WITHDRAWAL, TxType.BUY, TxType.SWAP]);

/**
 * How the money got in or out, worked out rather than stored.
 *
 * Nothing records a "payment method" because nothing chooses one — a naira
 * deposit is a bank transfer because that is the only way naira arrives, and a
 * coin withdrawal is a chain send because there is no other kind. Deriving it
 * keeps the column honest; storing it would create a field that could be wrong.
 */
function modeOf(type: TxType, fromAsset: string | null, toAsset: string | null): {
  mode: string;
  modeLabel: string;
} {
  const coin = (type === TxType.DEPOSIT ? toAsset : fromAsset)?.toUpperCase();

  switch (type) {
    case TxType.DEPOSIT:
      return toAsset === 'ngn'
        ? { mode: 'BANK', modeLabel: 'Bank transfer' }
        : { mode: 'CHAIN', modeLabel: `${coin} network` };
    case TxType.WITHDRAWAL:
      return fromAsset === 'ngn'
        ? { mode: 'BANK', modeLabel: 'Bank transfer' }
        : { mode: 'CHAIN', modeLabel: `${coin} network` };
    case TxType.BUY:
    case TxType.SELL:
      return { mode: 'NGN_BALANCE', modeLabel: 'Naira balance' };
    case TxType.GIFT_CARD:
      return { mode: 'GIFT_CARD', modeLabel: 'Gift card' };
    default:
      return { mode: 'INTERNAL', modeLabel: 'Internal' };
  }
}

type Row = Prisma.TransactionGetPayload<{
  include: { legs: true; user: { select: { firstName: true; lastName: true; email: true; kycTier: true } } };
}>;

/**
 * The three money figures for one transaction, in one unit.
 *
 * Total is what the trade was worth gross, fee is what the platform kept, and
 * amount is what reached the user — derived from the other two so the row can
 * never state arithmetic that does not work. Which stored column is which
 * depends on the side the fee came off: a buyer pays gross and receives net, a
 * seller is credited net.
 *
 * Rounded before the subtraction, for the same reason as the earnings manager:
 * a fee with more precision than money has would otherwise put the amount and
 * the fee on opposite sides of a half-unit and the row would stop adding up.
 */
export function figuresFor(t: {
  type: TxType;
  fromAsset: string | null;
  toAsset: string | null;
  fromAmount: Prisma.Decimal | null;
  toAmount: Prisma.Decimal | null;
  feeAmount: Prisma.Decimal | null;
  feeUsd: Prisma.Decimal | null;
  usdValue: Prisma.Decimal | null;
  gateApplied: Prisma.Decimal | null;
}): { unit: string; total: string; amount: string; fee: string } {
  const dp = (unit: string) => (unit === 'NGN' || unit === 'USD' ? 2 : 8);
  const out = (unit: string, totalRaw: Decimal, feeRaw: Decimal) => {
    const places = dp(unit);
    const total = totalRaw.toDecimalPlaces(places);
    const fee = feeRaw.toDecimalPlaces(places);
    return {
      unit,
      total: total.toFixed(places),
      fee: fee.toFixed(places),
      amount: total.minus(fee).toFixed(places),
    };
  };

  // The rate fee is folded into the price, so it is reconstructed from the
  // trade's dollar size and the naira gate that was live when it settled.
  const rateFee =
    t.usdValue && t.gateApplied ? dec(t.usdValue).mul(dec(t.gateApplied)) : ZERO;

  switch (t.type) {
    case TxType.BUY:
      // Gross naira in; the coin they received is already net of the fee.
      return out('NGN', dec(t.fromAmount ?? 0), rateFee);

    case TxType.SELL:
      // Credited net, so the gross is what they got plus what we kept.
      return out('NGN', dec(t.toAmount ?? 0).plus(rateFee), rateFee);

    case TxType.SWAP:
      // Two coins and a fee charged in a third unit of account. Dollars are the
      // only figure that means anything across all three.
      return out('USD', dec(t.usdValue ?? 0), dec(t.feeUsd ?? 0));

    case TxType.WITHDRAWAL: {
      // fromAmount is the total debited — what was sent plus our fee.
      const unit = (t.fromAsset ?? '').toUpperCase() || 'NGN';
      return out(unit, dec(t.fromAmount ?? 0), dec(t.feeAmount ?? 0));
    }

    case TxType.DEPOSIT: {
      // Nothing is charged for money arriving.
      const unit = (t.toAsset ?? '').toUpperCase() || 'NGN';
      return out(unit, dec(t.toAmount ?? 0), ZERO);
    }

    case TxType.GIFT_CARD:
      // The gross is what the desk realised for the card: what the user was
      // paid plus the margin. The margin can be negative, when a card cleared
      // below the rate quoted — which is a number worth seeing, not hiding.
      return out('NGN', dec(t.toAmount ?? 0).plus(dec(t.feeAmount ?? 0)), dec(t.feeAmount ?? 0));

    default: {
      const unit = (t.fromAsset ?? t.toAsset ?? '').toUpperCase() || 'NGN';
      return out(unit, dec(t.fromAmount ?? t.toAmount ?? 0), dec(t.feeAmount ?? 0));
    }
  }
}

/**
 * A naira deposit that arrived over the depositor's tier limit.
 *
 * The only thing on this screen anybody is asked to decide. The money has
 * already reached us — a bank transfer cannot be refused after the fact — so it
 * waits rather than being rejected, and the user's balance does not move until
 * somebody says it may.
 *
 * Deliberately narrow. A RECONCILING transaction is also stuck and also needs a
 * human eventually, but its outcome is genuinely UNKNOWN and resolving it by
 * hand is how a user ends up paid twice. Those are shown and never actionable.
 */
export function isAwaitingApproval(t: { type: TxType; status: TxStatus; toAsset: string | null }): boolean {
  return t.type === TxType.DEPOSIT && t.status === TxStatus.ON_HOLD && t.toAsset === 'ngn';
}

@Injectable()
export class AdminTransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
    private readonly kycLimits: KycLimitsService,
  ) {}

  private where(query: TxQuery): Prisma.TransactionWhereInput {
    const and: Prisma.TransactionWhereInput[] = [];

    if (query.tab === 'APPROVAL') {
      and.push({ type: TxType.DEPOSIT, status: TxStatus.ON_HOLD, toAsset: 'ngn' });
    } else if (query.tab && query.tab !== 'ALL') {
      and.push({ type: query.tab as TxType });
    }

    if (query.status) and.push({ status: query.status });
    if (query.type) and.push({ type: query.type });

    if (query.amountType === 'DEBIT') and.push({ type: { in: [...DEBITS] } });
    if (query.amountType === 'CREDIT') and.push({ type: { notIn: [...DEBITS] } });

    // Expressed as conditions on the columns the mode is derived from, so there
    // is one definition of what a bank transfer is rather than two.
    if (query.mode === 'BANK') {
      and.push({
        OR: [
          { type: TxType.DEPOSIT, toAsset: 'ngn' },
          { type: TxType.WITHDRAWAL, fromAsset: 'ngn' },
        ],
      });
    }
    if (query.mode === 'CHAIN') {
      and.push({
        OR: [
          { type: TxType.DEPOSIT, NOT: { toAsset: 'ngn' } },
          { type: TxType.WITHDRAWAL, NOT: { fromAsset: 'ngn' } },
        ],
      });
    }
    if (query.mode === 'NGN_BALANCE') and.push({ type: { in: [TxType.BUY, TxType.SELL] } });
    if (query.mode === 'GIFT_CARD') and.push({ type: TxType.GIFT_CARD });
    if (query.mode === 'INTERNAL') {
      and.push({ type: { in: [TxType.SWAP, TxType.FEE_CLAIM, TxType.INTERNAL] } });
    }

    if (query.from || query.to) {
      and.push({
        createdAt: {
          ...(query.from ? { gte: query.from } : {}),
          ...(query.to ? { lte: query.to } : {}),
        },
      });
    }

    const term = query.search?.trim();
    if (term) {
      // Prisma passes `contains` straight into LIKE without escaping anything,
      // so an unescaped '%' here would return every transaction ever made.
      const like = escapeLike(term);
      and.push({
        OR: [
          { reference: { contains: like, mode: 'insensitive' } },
          { quidaxRef: { contains: like, mode: 'insensitive' } },
          { user: { email: { contains: like, mode: 'insensitive' } } },
          { user: { firstName: { contains: like, mode: 'insensitive' } } },
          { user: { lastName: { contains: like, mode: 'insensitive' } } },
        ],
      });
    }

    return and.length ? { AND: and } : {};
  }

  async list(query: TxQuery): Promise<{
    rows: TxRow[];
    page: number;
    pageSize: number;
    total: number;
    counts: Record<string, number>;
    awaiting: number;
    stuck: number;
  }> {
    const pageSize = Math.min(Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const page = Math.max(query.page ?? 1, 1);
    const where = this.where(query);

    const [found, total, byType, awaiting, stuck] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        include: {
          legs: true,
          user: { select: { firstName: true, lastName: true, email: true, kycTier: true } },
        },
        orderBy: { createdAt: query.direction === 'asc' ? 'asc' : 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.transaction.count({ where }),

      /*
       * The tab counts, scoped by the date range only.
       *
       * Not by the tab itself, or every count would change the moment you
       * clicked one — telling you about the tab rather than about the business.
       */
      this.prisma.transaction.groupBy({
        by: ['type'],
        _count: { _all: true },
        where: this.where({ from: query.from, to: query.to }),
      }),
      this.prisma.transaction.count({
        where: { type: TxType.DEPOSIT, status: TxStatus.ON_HOLD, toAsset: 'ngn' },
      }),
      this.prisma.transaction.count({ where: { status: TxStatus.RECONCILING } }),
    ]);

    return {
      rows: await this.decorate(found),
      page,
      pageSize,
      total,
      counts: Object.fromEntries(byType.map((g) => [g.type, g._count._all])),
      // Never date-scoped: something waiting on a person is waiting now,
      // whatever period happens to be on screen.
      awaiting,
      stuck,
    };
  }

  /** Every matching row, for a CSV. Capped, and the caller is told if it hit. */
  async all(query: TxQuery): Promise<{ rows: TxRow[]; truncated: boolean }> {
    const CAP = 10_000;
    const found = await this.prisma.transaction.findMany({
      where: this.where(query),
      include: {
        legs: true,
        user: { select: { firstName: true, lastName: true, email: true, kycTier: true } },
      },
      orderBy: { createdAt: query.direction === 'asc' ? 'asc' : 'desc' },
      take: CAP + 1,
    });
    return {
      rows: await this.decorate(found.slice(0, CAP)),
      truncated: found.length > CAP,
    };
  }

  /**
   * Turn rows into what the screen shows, including who reviewed each one.
   *
   * The reviewer comes from the audit log rather than a column on the
   * transaction: the log is already the record of who did what, and a second
   * copy on the row is a second thing that can be wrong. One grouped query for
   * the whole page, not one per row.
   */
  private async decorate(found: Row[]): Promise<TxRow[]> {
    const reviewed = new Map<string, { by: string; at: Date }>();

    const ids = found.filter((t) => t.type === TxType.DEPOSIT).map((t) => t.id);
    if (ids.length) {
      const entries = await this.prisma.adminAuditLog.findMany({
        where: {
          entity: 'Transaction',
          entityId: { in: ids },
          action: { in: ['transaction.release', 'transaction.reject'] },
        },
        orderBy: { createdAt: 'desc' },
        include: { admin: { select: { name: true } } },
      });
      for (const e of entries) {
        if (e.entityId && !reviewed.has(e.entityId)) {
          reviewed.set(e.entityId, { by: e.admin?.name ?? 'an admin', at: e.createdAt });
        }
      }
    }

    /*
     * Ask again whether each held deposit would be allowed today.
     *
     * Computed on read rather than stamped on the row when a tier changes,
     * because a tier is not the only thing that can move: an admin editing the
     * KYC limits themselves can bring a held deposit inside the cap without
     * touching the depositor at all. A stored flag would miss that and quietly
     * go stale; asking the question fresh cannot.
     *
     * Only for rows actually waiting — usually a handful — and the same check
     * the deposit webhook ran, so the two can never disagree about what the
     * limit is.
     */
    const limits = new Map<string, { within: boolean; reason: string | null }>();
    const waiting = found.filter(isAwaitingApproval);
    await Promise.all(
      waiting.map(async (t) => {
        try {
          const verdict = await this.kycLimits.check(
            t.userId,
            t.user.kycTier,
            'deposit',
            dec(t.toAmount ?? 0),
            new Date(),
            // Excluded, or its own amount would be counted twice: once in
            // today's total, which already includes held deposits, and once as
            // the amount being tested.
            t.id,
          );
          limits.set(t.id, { within: verdict.allowed, reason: verdict.reason ?? null });
        } catch {
          // A limits lookup that fails must not take the whole queue down with
          // it. The row still shows; it just cannot say whether it now fits.
        }
      }),
    );

    return found.map((t) => {
      const figures = figuresFor(t);
      const { mode, modeLabel } = modeOf(t.type, t.fromAsset, t.toAsset);
      const review = reviewed.get(t.id);

      return {
        id: t.id,
        reference: t.reference,
        type: t.type,
        status: t.status,
        amountType: DEBITS.has(t.type) ? 'DEBIT' : 'CREDIT',
        ...figures,
        networkFee: t.networkFee ? str(t.networkFee) : null,
        mode,
        modeLabel,
        fromAsset: t.fromAsset,
        toAsset: t.toAsset,
        fromAmount: t.fromAmount ? str(t.fromAmount) : null,
        toAmount: t.toAmount ? str(t.toAmount) : null,
        settledFrom: t.settledFrom,
        quidaxRawStatus: t.quidaxRawStatus,
        failureReason: t.failureReason,
        legs: t.legs.map((l) => ({
          kind: l.kind,
          state: l.state,
          amount: str(l.amount),
          reference: l.reference,
          lastError: l.lastError,
        })),
        userId: t.userId,
        name: `${t.user.firstName} ${t.user.lastName}`.trim(),
        email: t.user.email,
        createdAt: t.createdAt.toISOString(),
        completedAt: t.completedAt?.toISOString() ?? null,
        needsApproval: isAwaitingApproval(t),
        withinLimitsNow: limits.get(t.id)?.within ?? null,
        limitReason: limits.get(t.id)?.reason ?? null,
        reviewedBy: review?.by ?? null,
        reviewedAt: review?.at.toISOString() ?? null,
      };
    });
  }

  /**
   * The one transaction an admin may act on, or a refusal that says why.
   *
   * Every guard is re-checked inside the write below as well. This one is for
   * the error message; that one is for correctness.
   */
  private async held(id: string) {
    const tx = await this.prisma.transaction.findUnique({
      where: { id },
      include: { user: { select: { firstName: true, email: true } } },
    });
    if (!tx) throw new NotFoundException('No such transaction');

    if (tx.type !== TxType.DEPOSIT || tx.toAsset !== 'ngn') {
      throw new BadRequestException(
        'Only a naira deposit can be released or rejected here. Nothing else on this screen is decided by hand.',
      );
    }
    if (tx.status !== TxStatus.ON_HOLD) {
      throw new ConflictException(
        `This deposit is ${tx.status.toLowerCase().replace('_', ' ')}, not on hold — somebody may have already dealt with it.`,
      );
    }
    return tx;
  }

  /**
   * Credit a held naira deposit.
   *
   * The money arrived at the bank long before this; what was missing was
   * permission to let it past the tier limit. Releasing does exactly what the
   * webhook would have done had the limit not caught it: one ledger entry,
   * COMPLETED, and the user is told.
   *
   * The status is re-read INSIDE the serializable write and the update is
   * conditional on it, so two admins clicking Release at the same moment credit
   * the balance once. The second one gets told it was already done.
   */
  async release(id: string): Promise<TxRow> {
    const tx = await this.held(id);
    const amount = dec(tx.toAmount ?? 0);
    if (amount.lte(0)) {
      throw new BadRequestException('That deposit has no amount to credit');
    }

    await this.prisma.serializable(
      async (t) => {
        const current = await t.transaction.findUniqueOrThrow({
          where: { id },
          select: { status: true },
        });
        if (current.status !== TxStatus.ON_HOLD) {
          throw new ConflictException('That deposit was already dealt with');
        }

        await this.ledger.credit(t, {
          userId: tx.userId,
          assetCode: 'ngn',
          amount,
          counterparty: LedgerAccount.EXTERNAL,
          transactionId: tx.id,
          memo: `held deposit released ${tx.reference}`,
        });

        await t.transaction.update({
          where: { id },
          data: {
            status: TxStatus.COMPLETED,
            completedAt: new Date(),
            // The hold reason is not a failure, and leaving it on a completed
            // deposit would read as one.
            failureReason: null,
          },
        });
      },
      // Losing the race means another admin released it first — which is the
      // same answer as the status check above, so it reads the same way.
      { conflict: 'That deposit was already dealt with' },
    );

    await this.notifications.notify({
      userId: tx.userId,
      transactionId: tx.id,
      type: 'deposit.credited',
      title: `₦${str(amount, 2)} added`,
      body: 'Your naira deposit has been reviewed and added to your balance.',
      email: {
        key: 'ngn.deposit.credited',
        variables: { amount: str(amount, 2), transactionId: tx.reference },
      },
    });

    return this.one(id);
  }

  /**
   * Refuse a held naira deposit.
   *
   * No money moves — it never reached a balance, and it is not ours to send
   * back from here. This records the decision and its reason, and tells the
   * user, so the deposit stops sitting in a queue forever with nobody able to
   * say what was decided about it.
   */
  async reject(id: string, reason: string): Promise<TxRow> {
    const tx = await this.held(id);
    const trimmed = reason.trim();
    if (!trimmed) throw new BadRequestException('Say why — the user is shown this');

    await this.prisma.serializable(
      async (t) => {
        const current = await t.transaction.findUniqueOrThrow({
          where: { id },
          select: { status: true },
        });
        if (current.status !== TxStatus.ON_HOLD) {
          throw new ConflictException('That deposit was already dealt with');
        }
        await t.transaction.update({
          where: { id },
          data: { status: TxStatus.FAILED, failureReason: trimmed },
        });
      },
      { conflict: 'That deposit was already dealt with' },
    );

    await this.notifications.notify({
      userId: tx.userId,
      transactionId: tx.id,
      type: 'deposit.failed',
      title: 'Deposit not completed',
      body: trimmed,
      email: {
        key: 'deposit.failed',
        variables: {
          amount: str(dec(tx.toAmount ?? 0), 2),
          assetCode: 'NGN',
          reason: trimmed,
          transactionId: tx.reference,
        },
      },
    });

    return this.one(id);
  }

  async one(id: string): Promise<TxRow> {
    const found = await this.prisma.transaction.findUnique({
      where: { id },
      include: {
        legs: true,
        user: { select: { firstName: true, lastName: true, email: true, kycTier: true } },
      },
    });
    if (!found) throw new NotFoundException('No such transaction');
    return (await this.decorate([found]))[0];
  }
}
