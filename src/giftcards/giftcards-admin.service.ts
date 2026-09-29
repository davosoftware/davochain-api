import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GiftCardTradeStatus, LedgerAccount, Prisma, TxStatus, TxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SecretBox } from '../common/secret-box';
import { GiftCardsService, decodeImage } from './giftcards.service';
import { isKnownCurrency, symbolFor } from './currencies';
import { Decimal, ZERO, dec, str } from '../common/money';

@Injectable()
export class GiftCardsAdminService {
  private readonly log = new Logger(GiftCardsAdminService.name);
  private readonly box: SecretBox;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
    private readonly giftcards: GiftCardsService,
    config: ConfigService,
  ) {
    this.box = new SecretBox(config.get<string>('CREDENTIALS_KEY'));
  }

  // ── brand categories ──────────────────────────────────────

  async categories() {
    const rows = await this.prisma.giftCardBrandCategory.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { brands: true } } },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      isActive: c.isActive,
      brandCount: c._count.brands,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));
  }

  async saveCategory(adminId: string, input: { id?: string; name: string; isActive?: boolean }) {
    const name = input.name.trim();
    if (!name) throw new BadRequestException('Give the category a name');

    try {
      if (input.id) {
        return await this.prisma.giftCardBrandCategory.update({
          where: { id: input.id },
          data: { name, ...(input.isActive === undefined ? {} : { isActive: input.isActive }), updatedBy: adminId },
        });
      }
      return await this.prisma.giftCardBrandCategory.create({ data: { name, updatedBy: adminId } });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException(`There is already a category called ${name}`);
      }
      throw err;
    }
  }

  /**
   * Remove a category, but only if nothing hangs off it.
   *
   * A category with brands cannot go: every past trade names the card it was,
   * and dropping the category out from under it turns readable history into a
   * dangling id. The refusal says what is in the way, and deactivating is the
   * answer — it disappears from the app and the history stays whole.
   */
  async deleteCategory(id: string) {
    const brands = await this.prisma.giftCardBrand.count({ where: { categoryId: id } });
    if (brands > 0) {
      throw new ConflictException(
        `${brands} brand${brands === 1 ? ' still uses' : 's still use'} this category. Deactivate it instead — it disappears from the app and past trades keep their card name.`,
      );
    }
    await this.prisma.giftCardBrandCategory.delete({ where: { id } });
    return { deleted: true };
  }

  // ── brands ────────────────────────────────────────────────

  async brands() {
    const rows = await this.prisma.giftCardBrand.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { category: true, _count: { select: { types: true } } },
    });
    return rows.map((b) => ({
      id: b.id,
      name: b.name,
      category: { id: b.category.id, name: b.category.name },
      imageUrl: this.giftcards.brandImageUrl(b),
      isActive: b.isActive,
      typeCount: b._count.types,
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
    }));
  }

  async saveBrand(
    adminId: string,
    input: { id?: string; name: string; categoryId: string; image?: string; isActive?: boolean },
  ) {
    const name = input.name.trim();
    if (!name) throw new BadRequestException('Give the brand a name');

    const category = await this.prisma.giftCardBrandCategory.findUnique({
      where: { id: input.categoryId },
    });
    if (!category) throw new BadRequestException('Pick a brand category');

    const picture = input.image ? decodeImage(input.image) : null;

    /*
     * Built by assignment rather than by spreading a conditional object.
     *
     * A spread of `{...} | {}` widens the Buffer's type and Prisma stops
     * accepting it; assigning onto a typed object keeps the contextual type
     * intact. Omitting the image fields entirely — rather than sending null —
     * is also what leaves an existing logo alone when a brand is renamed.
     */
    const data: Prisma.GiftCardBrandUncheckedCreateInput = {
      name,
      categoryId: input.categoryId,
      updatedBy: adminId,
    };
    if (picture) {
      data.image = picture.buffer;
      data.imageType = picture.type;
      data.imageUpdatedAt = new Date();
    }
    if (input.isActive !== undefined) data.isActive = input.isActive;

    try {
      if (input.id) {
        return await this.prisma.giftCardBrand.update({ where: { id: input.id }, data });
      }
      return await this.prisma.giftCardBrand.create({ data });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException(`There is already a brand called ${name}`);
      }
      throw err;
    }
  }

  async deleteBrand(id: string) {
    const types = await this.prisma.giftCardType.count({ where: { brandId: id } });
    if (types > 0) {
      throw new ConflictException(
        `${types} card type${types === 1 ? ' still uses' : 's still use'} this brand. Deactivate it instead.`,
      );
    }
    await this.prisma.giftCardBrand.delete({ where: { id } });
    return { deleted: true };
  }

  // ── types ─────────────────────────────────────────────────

  async types() {
    const rows = await this.prisma.giftCardType.findMany({
      orderBy: [{ brand: { name: 'asc' } }, { name: 'asc' }],
      include: {
        brand: { include: { category: true } },
        _count: { select: { trades: true } },
      },
    });
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      brand: { id: t.brand.id, name: t.brand.name },
      category: { id: t.brand.category.id, name: t.brand.category.name },
      currency: t.currency,
      /** So no screen has to carry its own code-to-symbol table. */
      currencySymbol: symbolFor(t.currency),
      minAmount: str(t.minAmount, 2),
      maxAmount: str(t.maxAmount, 2),
      rateNgn: str(t.rateNgn, 2),
      isActive: t.isActive,
      tradeCount: t._count.trades,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    }));
  }

  async saveType(
    adminId: string,
    input: {
      id?: string;
      brandId: string;
      name: string;
      currency: string;
      minAmount: string;
      maxAmount: string;
      rateNgn: string;
      isActive?: boolean;
    },
  ) {
    const name = input.name.trim();
    if (!name) throw new BadRequestException('Give the card type a name');

    const brand = await this.prisma.giftCardBrand.findUnique({ where: { id: input.brandId } });
    if (!brand) throw new BadRequestException('Pick a brand');

    const min = dec(input.minAmount);
    const max = dec(input.maxAmount);
    const rate = dec(input.rateNgn);

    if (!min.isFinite() || min.lte(0)) throw new BadRequestException('Enter a minimum above zero');
    if (!max.isFinite() || max.lte(0)) throw new BadRequestException('Enter a maximum above zero');
    if (max.lt(min)) throw new BadRequestException('The maximum cannot be below the minimum');
    if (!rate.isFinite() || rate.lte(0)) throw new BadRequestException('Enter a rate above zero');

    const currency = input.currency.trim().toUpperCase();
    // Checked against the list the app has symbols for, not just "three
    // letters" — a typo'd code would store fine and then render an amount
    // field with no symbol beside it.
    if (!isKnownCurrency(currency)) {
      throw new BadRequestException(
        `${currency} is not a currency we hold rates in. Pick one from the list.`,
      );
    }

    const data = {
      brandId: input.brandId,
      name,
      currency,
      minAmount: min.toFixed(),
      maxAmount: max.toFixed(),
      rateNgn: rate.toFixed(),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      updatedBy: adminId,
    };

    try {
      return input.id
        ? await this.prisma.giftCardType.update({ where: { id: input.id }, data })
        : await this.prisma.giftCardType.create({ data });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException(`${brand.name} already has a type called ${name}`);
      }
      throw err;
    }
  }

  async deleteType(id: string) {
    const trades = await this.prisma.giftCardTrade.count({ where: { typeId: id } });
    if (trades > 0) {
      throw new ConflictException(
        `${trades} trade${trades === 1 ? ' references' : 's reference'} this card type. Deactivate it instead — it disappears from the app and the history stays readable.`,
      );
    }
    await this.prisma.giftCardType.delete({ where: { id } });
    return { deleted: true };
  }

  // ── the queue ─────────────────────────────────────────────

  async trades(query: {
    status?: GiftCardTradeStatus;
    search?: string;
    page?: number;
    pageSize?: number;
  }) {
    const pageSize = Math.min(Math.max(query.pageSize ?? 25, 1), 200);
    const page = Math.max(query.page ?? 1, 1);

    const term = query.search?.trim();
    const like = term ? term.replace(/[\\%_]/g, (c) => `\\${c}`) : null;
    const where: Prisma.GiftCardTradeWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(like
        ? {
            OR: [
              { user: { email: { contains: like, mode: Prisma.QueryMode.insensitive } } },
              { user: { firstName: { contains: like, mode: Prisma.QueryMode.insensitive } } },
              { user: { lastName: { contains: like, mode: Prisma.QueryMode.insensitive } } },
              { type: { brand: { name: { contains: like, mode: Prisma.QueryMode.insensitive } } } },
            ],
          }
        : {}),
    };

    const [rows, total, waiting, profit] = await Promise.all([
      this.prisma.giftCardTrade.findMany({
        where,
        include: {
          user: { select: { firstName: true, lastName: true, email: true } },
          type: { include: { brand: true } },
          images: { select: { id: true }, orderBy: { sortOrder: 'asc' } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.giftCardTrade.count({ where }),
      this.prisma.giftCardTrade.count({ where: { status: GiftCardTradeStatus.PENDING } }),
      this.prisma.giftCardTrade.aggregate({ _sum: { profitNgn: true, creditedNgn: true } }),
    ]);

    return {
      rows: rows.map((t) => this.adminView(t)),
      page,
      pageSize,
      total,
      /** Never date-scoped: something waiting on a person is waiting now. */
      waiting,
      totals: {
        profitNgn: str(dec(profit._sum.profitNgn ?? 0), 2),
        creditedNgn: str(dec(profit._sum.creditedNgn ?? 0), 2),
      },
    };
  }

  /** One trade, with the code decrypted — the only place that happens. */
  async trade(id: string) {
    const t = await this.prisma.giftCardTrade.findUnique({
      where: { id },
      include: {
        user: { select: { firstName: true, lastName: true, email: true } },
        type: { include: { brand: true } },
        images: { select: { id: true }, orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!t) throw new NotFoundException('No such trade');

    return {
      ...this.adminView(t),
      /*
       * Decrypted here and only here. Null means either no code was given or
       * the key has changed — the screen says which rather than showing an
       * empty box that reads as "the user sent nothing".
       */
      code: t.codeSealed ? this.box.open(t.codeSealed) : null,
      codeUnreadable: Boolean(t.codeSealed) && this.box.open(t.codeSealed) === null,
    };
  }

  private adminView(t: {
    id: string;
    faceValue: Prisma.Decimal;
    currency: string;
    rateNgn: Prisma.Decimal;
    expectedNgn: Prisma.Decimal;
    status: GiftCardTradeStatus;
    approvedValue: Prisma.Decimal | null;
    approvedRateNgn: Prisma.Decimal | null;
    actualRateNgn: Prisma.Decimal | null;
    creditedNgn: Prisma.Decimal | null;
    profitNgn: Prisma.Decimal | null;
    reason: string | null;
    reviewedBy: string | null;
    reviewedAt: Date | null;
    codeSealed: string | null;
    createdAt: Date;
    user: { firstName: string; lastName: string; email: string };
    type: { name: string; brand: { name: string } };
    images: { id: string }[];
  }) {
    return {
      id: t.id,
      user: { name: `${t.user.firstName} ${t.user.lastName}`.trim(), email: t.user.email },
      brand: t.type.brand.name,
      type: t.type.name,
      currency: t.currency,
      currencySymbol: symbolFor(t.currency),
      faceValue: str(t.faceValue, 2),
      rateNgn: str(t.rateNgn, 2),
      expectedNgn: str(t.expectedNgn, 2),
      status: t.status,
      approvedValue: t.approvedValue ? str(t.approvedValue, 2) : null,
      approvedRateNgn: t.approvedRateNgn ? str(t.approvedRateNgn, 2) : null,
      /** Admin-only. Never reaches a user endpoint. */
      actualRateNgn: t.actualRateNgn ? str(t.actualRateNgn, 2) : null,
      creditedNgn: t.creditedNgn ? str(t.creditedNgn, 2) : null,
      profitNgn: t.profitNgn ? str(t.profitNgn, 2) : null,
      reason: t.reason,
      hasCode: Boolean(t.codeSealed),
      images: t.images.map((i) => `/v1/admin/giftcards/trades/${t.id}/images/${i.id}`),
      reviewedBy: t.reviewedBy,
      reviewedAt: t.reviewedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
    };
  }

  // ── the three decisions ───────────────────────────────────

  /**
   * Accept a card in full, at the rate the user was shown.
   *
   * `actualRateNgn` is what the desk cleared it at. The difference between
   * that and the rate quoted to the user is the margin, and it is the only
   * thing the desk earns here — the user is paid exactly what their screen
   * promised, whatever the card turned out to fetch.
   */
  async approve(adminId: string, id: string, actualRateNgn: string) {
    const trade = await this.pending(id);
    return this.settle(adminId, trade, {
      approvedValue: dec(trade.faceValue),
      approvedRateNgn: dec(trade.rateNgn),
      actualRateNgn: this.rate(actualRateNgn),
      status: GiftCardTradeStatus.APPROVED,
      reason: null,
    });
  }

  /**
   * Accept a card for less than was claimed.
   *
   * For the card that turns out to be worth $60 rather than the $100 on the
   * form, or that is half spent. Three figures, because all three can differ
   * from what was submitted: what the card is really worth, what we will pay
   * per unit, and what we actually cleared it at.
   */
  async partiallyApprove(
    adminId: string,
    id: string,
    input: { approvedValue: string; approvedRateNgn: string; actualRateNgn: string; reason: string },
  ) {
    const trade = await this.pending(id);

    const value = dec(input.approvedValue);
    if (!value.isFinite() || value.lte(0)) {
      throw new BadRequestException('Enter what the card is actually worth');
    }
    if (value.gt(dec(trade.faceValue))) {
      throw new BadRequestException(
        `That is more than the ${str(trade.faceValue, 2)} ${trade.currency} they submitted. Approve it in full instead.`,
      );
    }
    const reason = input.reason?.trim();
    if (!reason) throw new BadRequestException('Say why — the user is shown this');

    return this.settle(adminId, trade, {
      approvedValue: value,
      approvedRateNgn: this.rate(input.approvedRateNgn),
      actualRateNgn: this.rate(input.actualRateNgn),
      status: GiftCardTradeStatus.PARTIALLY_APPROVED,
      reason,
    });
  }

  /** Refuse a card. Nothing moves; the user is told why. */
  async reject(adminId: string, id: string, reason: string) {
    const trade = await this.pending(id);
    const text = reason?.trim();
    if (!text) throw new BadRequestException('Say why — the user is shown this');

    const updated = await this.prisma.giftCardTrade.updateMany({
      where: { id, status: GiftCardTradeStatus.PENDING },
      data: {
        status: GiftCardTradeStatus.REJECTED,
        reason: text,
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
    });
    if (updated.count === 0) throw new ConflictException('That card was already dealt with');

    await this.notifications.notify({
      userId: trade.userId,
      type: 'deposit.failed',
      title: 'Card not accepted',
      body: text,
    });
    return this.trade(id);
  }

  private rate(value: string): Decimal {
    const rate = dec(value);
    if (!rate.isFinite() || rate.lte(0)) {
      throw new BadRequestException('Enter a rate above zero');
    }
    return rate;
  }

  private async pending(id: string) {
    const trade = await this.prisma.giftCardTrade.findUnique({
      where: { id },
      include: { type: { include: { brand: true } } },
    });
    if (!trade) throw new NotFoundException('No such trade');
    if (trade.status !== GiftCardTradeStatus.PENDING) {
      throw new ConflictException(
        `That card is already ${trade.status.toLowerCase().replace(/_/g, ' ')} — somebody may have dealt with it.`,
      );
    }
    return trade;
  }

  /**
   * Pay for a card and record what it earned.
   *
   * One serializable write: the naira credit, its ledger entry, and the trade
   * marked decided. All three or none — a credit without the status change
   * would pay again on the next click.
   *
   * The margin is stored on the transaction as `feeAmount`, in naira, which is
   * exactly where the earnings manager reads every other naira fee from. It is
   * NOT a separate ledger movement: like the rate fee folded into a buy, it is
   * value that never entered the user's balance in the first place.
   */
  private async settle(
    adminId: string,
    trade: { id: string; userId: string; currency: string; type: { name: string; brand: { name: string } } },
    decision: {
      approvedValue: Decimal;
      approvedRateNgn: Decimal;
      actualRateNgn: Decimal;
      status: GiftCardTradeStatus;
      reason: string | null;
    },
  ) {
    const credited = decision.approvedValue.mul(decision.approvedRateNgn);
    /*
     * Can be NEGATIVE, and deliberately so.
     *
     * If the desk clears a card BELOW the rate the user was quoted, the trade
     * lost money. Clamping that to zero would hide exactly the number somebody
     * needs to see — a rate set too generously shows up here first.
     */
    const profit = decision.approvedValue.mul(decision.actualRateNgn.minus(decision.approvedRateNgn));

    const paid = await this.prisma.serializable(
      async (t) => {
        const claimed = await t.giftCardTrade.updateMany({
          where: { id: trade.id, status: GiftCardTradeStatus.PENDING },
          data: {
            status: decision.status,
            approvedValue: decision.approvedValue.toFixed(),
            approvedRateNgn: decision.approvedRateNgn.toFixed(),
            actualRateNgn: decision.actualRateNgn.toFixed(),
            creditedNgn: credited.toFixed(),
            profitNgn: profit.toFixed(),
            reason: decision.reason,
            reviewedBy: adminId,
            reviewedAt: new Date(),
          },
        });
        if (claimed.count === 0) return null;

        const tx = await t.transaction.create({
          data: {
            userId: trade.userId,
            type: TxType.GIFT_CARD,
            status: TxStatus.COMPLETED,
            toAsset: 'ngn',
            toAmount: credited.toFixed(),
            // The margin, where every other naira fee lives.
            feeAmount: profit.toFixed(),
            feeAsset: 'ngn',
            reference: `giftcard_${trade.id}`,
            completedAt: new Date(),
          },
        });

        await this.ledger.credit(t, {
          userId: trade.userId,
          assetCode: 'ngn',
          amount: credited,
          // The naira came from selling the card on, which is outside.
          counterparty: LedgerAccount.EXTERNAL,
          transactionId: tx.id,
          memo: `gift card ${trade.type.brand.name} ${trade.type.name}`,
        });

        await t.giftCardTrade.update({
          where: { id: trade.id },
          data: { transactionId: tx.id },
        });
        return tx.id;
      },
      { conflict: 'That card was already dealt with' },
    );

    if (!paid) throw new ConflictException('That card was already dealt with');

    await this.notifications.notify({
      userId: trade.userId,
      transactionId: paid,
      type: 'deposit.credited',
      title: `₦${str(credited, 2)} for your ${trade.type.brand.name} card`,
      body:
        decision.status === GiftCardTradeStatus.PARTIALLY_APPROVED
          ? `Accepted for ${str(decision.approvedValue, 2)} ${trade.currency}. ${decision.reason ?? ''}`.trim()
          : 'It has been added to your naira balance.',
    });

    this.log.log(
      `Gift card ${trade.id} ${decision.status}: credited ₦${str(credited, 2)}, margin ₦${str(profit, 2)}`,
    );
    return this.trade(trade.id);
  }

}
