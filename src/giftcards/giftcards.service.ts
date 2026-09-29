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
import { currency as currencyOf, symbolFor } from './currencies';
import { Decimal, ZERO, dec, str } from '../common/money';

/** What a photograph of a card may be. Nothing else is stored. */
const IMAGE_TYPES: Record<string, string> = {
  '/9j/': 'image/jpeg',
  iVBORw0KGgo: 'image/png',
  UklGR: 'image/webp',
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 5;

/**
 * The picture's real type, from its first bytes.
 *
 * Never from the data URL's own claim: a file that says image/png and is
 * actually HTML is the oldest way to get a script served back from an
 * endpoint that promises a picture.
 */
export function detectImageType(buffer: Buffer): string | null {
  const head = buffer.subarray(0, 16).toString('base64');
  for (const [magic, type] of Object.entries(IMAGE_TYPES)) {
    if (head.startsWith(magic)) return type;
  }
  return null;
}

/**
 * A data URL as bytes, or a reason it is not a picture.
 *
 * The return type is inferred deliberately. Annotating it as `Buffer` widens
 * to `Buffer<ArrayBufferLike>`, which Prisma's Bytes column will not take —
 * `Buffer.from(str, 'base64')` already gives the narrower type it wants.
 */
export function decodeImage(dataUrl: string) {
  const comma = dataUrl.indexOf(',');
  const raw = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
  const buffer = Buffer.from(raw, 'base64');

  if (buffer.length === 0) throw new BadRequestException('That image is empty');
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new BadRequestException('Each image must be 5 MB or smaller');
  }
  const type = detectImageType(buffer);
  if (!type) {
    throw new BadRequestException('Images must be JPEG, PNG or WebP');
  }
  return { buffer, type };
}

@Injectable()
export class GiftCardsService {
  private readonly log = new Logger(GiftCardsService.name);
  private readonly box: SecretBox;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {
    this.box = new SecretBox(config.get<string>('CREDENTIALS_KEY'));
  }

  /**
   * Where the API answers from, as the outside world reaches it.
   *
   * Public image URLs are absolute for the same reason the social icons are:
   * a phone has no idea what the API's address is, and a relative path makes
   * every client invent its own prefixing rule.
   */
  private base(): string {
    return (this.config.get<string>('PUBLIC_API_URL') ?? 'http://localhost:3000').replace(
      /\/$/,
      '',
    );
  }

  /**
   * A brand logo, or null when none was uploaded.
   *
   * Public and versioned, so the app and the dashboard both point an <img>
   * straight at it — no token, no proxy — and the browser caches it forever,
   * because a new picture produces a new URL.
   */
  brandImageUrl(brand: { id: string; imageUpdatedAt: Date | null }): string | null {
    return brand.imageUpdatedAt
      ? `${this.base()}/v1/giftcards/brands/${brand.id}/image?v=${brand.imageUpdatedAt.getTime()}`
      : null;
  }

  // ── what the app sees ─────────────────────────────────────

  /**
   * The whole catalogue, ready to render.
   *
   * Only what is live: a deactivated category hides its brands, and a
   * deactivated brand hides its types, because a card somebody cannot
   * actually trade should not be on the screen offering a rate.
   */
  async catalogue() {
    const categories = await this.prisma.giftCardBrandCategory.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      include: {
        brands: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: {
            types: {
              where: { isActive: true },
              orderBy: { name: 'asc' },
            },
          },
        },
      },
    });

    return categories
      .map((c) => ({
        id: c.id,
        name: c.name,
        brands: c.brands
          .filter((b) => b.types.length > 0)
          .map((b) => ({
            id: b.id,
            name: b.name,
            /** Null when no logo has been uploaded — draw the name instead. */
            imageUrl: this.brandImageUrl(b),
            types: b.types.map((t) => ({
              id: t.id,
              name: t.name,
              currency: t.currency,
              /** Drawn beside the amount field. The app never maps this itself. */
              currencySymbol: symbolFor(t.currency),
              /**
               * Whether the symbol goes before the number. False for the
               * Nordic krona and the złoty — "500 kr", not "kr 500". Sent so
               * the app needs no special case of its own.
               */
              currencySymbolFirst: currencyOf(t.currency)?.symbolFirst ?? true,
              minAmount: str(t.minAmount, 2),
              maxAmount: str(t.maxAmount, 2),
              /** Naira per unit of `currency`. Shown under the amount field. */
              rateNgn: str(t.rateNgn, 2),
            })),
          })),
      }))
      // A category whose brands all lack a tradeable type is an empty heading.
      .filter((c) => c.brands.length > 0);
  }

  async brandImage(brandId: string): Promise<{ image: Buffer; type: string }> {
    const brand = await this.prisma.giftCardBrand.findUnique({
      where: { id: brandId },
      select: { image: true, imageType: true },
    });
    if (!brand?.image || !brand.imageType) throw new NotFoundException('No image');
    return { image: Buffer.from(brand.image), type: brand.imageType };
  }

  // ── trading ───────────────────────────────────────────────

  /**
   * Offer a card.
   *
   * The rate is READ AND FROZEN here. An admin repricing the type an hour
   * later must not change what this person was shown, in either direction —
   * a promise made on a screen is a promise.
   */
  async submit(
    userId: string,
    input: { typeId: string; faceValue: string; code?: string; images: string[] },
  ) {
    const type = await this.prisma.giftCardType.findUnique({
      where: { id: input.typeId },
      include: { brand: { include: { category: true } } },
    });
    if (!type || !type.isActive || !type.brand.isActive || !type.brand.category.isActive) {
      throw new BadRequestException('That card is not available to trade right now');
    }

    const value = dec(input.faceValue);
    if (!value.isFinite() || value.lte(0)) {
      throw new BadRequestException('Enter the value of the card');
    }
    if (value.lt(dec(type.minAmount)) || value.gt(dec(type.maxAmount))) {
      throw new BadRequestException(
        `${type.brand.name} ${type.name} takes between ${str(type.minAmount, 2)} and ${str(type.maxAmount, 2)} ${type.currency}`,
      );
    }

    const code = input.code?.trim();
    const images = (input.images ?? []).slice(0, MAX_IMAGES);
    // A card with neither a photo nor a code is nothing anybody can check.
    if (images.length === 0 && !code) {
      throw new BadRequestException('Add a photo of the card, or type its code');
    }
    if (code && !this.box.isConfigured) {
      throw new BadRequestException(
        'Card codes cannot be accepted right now. Send a photo instead, or try again shortly.',
      );
    }

    const decoded = images.map((img) => decodeImage(img));
    const rate = dec(type.rateNgn);

    const trade = await this.prisma.giftCardTrade.create({
      data: {
        userId,
        typeId: type.id,
        faceValue: value.toFixed(),
        currency: type.currency,
        rateNgn: rate.toFixed(),
        expectedNgn: value.mul(rate).toFixed(),
        codeSealed: code ? this.box.seal(code) : null,
        images: {
          create: decoded.map((d, i) => ({
            image: d.buffer,
            imageType: d.type,
            sortOrder: i,
          })),
        },
      },
    });

    await this.notifications.notify({
      userId,
      type: 'deposit.detected',
      title: 'Card submitted',
      body: `Your ${type.brand.name} ${type.name} is being checked. You will be told as soon as it is done.`,
    });

    return this.mine(userId, trade.id);
  }

  /** One trade, or the caller's whole history. Never includes the code. */
  async mine(userId: string, tradeId?: string) {
    const rows = await this.prisma.giftCardTrade.findMany({
      where: { userId, ...(tradeId ? { id: tradeId } : {}) },
      include: {
        type: { include: { brand: true } },
        images: { select: { id: true, sortOrder: true }, orderBy: { sortOrder: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
      take: tradeId ? 1 : 100,
    });

    const view = rows.map((t) => ({
      id: t.id,
      brand: t.type.brand.name,
      type: t.type.name,
      currency: t.currency,
      currencySymbol: symbolFor(t.currency),
      currencySymbolFirst: currencyOf(t.currency)?.symbolFirst ?? true,
      faceValue: str(t.faceValue, 2),
      /** The rate they were shown, frozen at submission. */
      rateNgn: str(t.rateNgn, 2),
      expectedNgn: str(t.expectedNgn, 2),
      status: t.status,
      /*
       * What actually landed, once it has. Null while pending, and null
       * forever on a rejection — which is how the row itself says whether
       * money moved.
       */
      creditedNgn: t.creditedNgn ? str(t.creditedNgn, 2) : null,
      approvedValue: t.approvedValue ? str(t.approvedValue, 2) : null,
      /** Why it was partly accepted or refused, in the admin's own words. */
      reason: t.reason,
      images: t.images.map((i) => `/v1/giftcards/trades/${t.id}/images/${i.id}`),
      createdAt: t.createdAt.toISOString(),
      reviewedAt: t.reviewedAt?.toISOString() ?? null,
      // actualRateNgn and profitNgn are deliberately absent. They are the buy
      // side of our own trade and are never sent to the person selling.
    }));

    /*
     * A trade that is not theirs and a trade that does not exist are the same
     * answer, deliberately: telling them apart would let anybody count our
     * trades by probing ids.
     *
     * It has to be a throw rather than null. Returning null here made Nest
     * send 200 with a zero-byte body and no content-type, which every client
     * reads as success and then fails to parse.
     */
    if (tradeId && !view[0]) throw new NotFoundException('No such card');
    return tradeId ? view[0] : view;
  }

  /** A photograph the user themselves uploaded. Scoped to them. */
  async tradeImage(userId: string | null, tradeId: string, imageId: string) {
    const image = await this.prisma.giftCardTradeImage.findFirst({
      where: {
        id: imageId,
        tradeId,
        // null means an admin is asking, and an admin may see any of them.
        ...(userId ? { trade: { userId } } : {}),
      },
      select: { image: true, imageType: true },
    });
    if (!image) throw new NotFoundException('No image');
    return { image: Buffer.from(image.image), type: image.imageType };
  }
}
