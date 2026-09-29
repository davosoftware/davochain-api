import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { FeeKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Decimal, ZERO, dec } from '../common/money';

export interface BandInput {
  minAmount: string;
  /** null or omitted on the top band — everything above minAmount. */
  maxAmount?: string | null;
  /** ₦ per $ on a RATE ladder; flat $ on a SWAP one. */
  value: string;
}

export interface ResolvedBand {
  scheduleId: string;
  bandId: string;
  minAmount: Decimal;
  maxAmount: Decimal | null;
  value: Decimal;
  /** True when the coin has no ladder of its own and fell back to global. */
  fromGlobal: boolean;
}

/**
 * What each ladder is called, and what its two numbers mean.
 *
 * `bandUnit` is the currency the RUNGS are measured in; `unit` is the currency
 * the FEE is charged in. They differ on the rate ladder, where a dollar-sized
 * band carries a naira-per-dollar gate.
 */
const NAMES: Record<FeeKind, { fee: string; unit: string; bandUnit: 'USD' | 'NGN' }> = {
  [FeeKind.RATE]: { fee: 'rate fee', unit: '₦ per $', bandUnit: 'USD' },
  [FeeKind.SWAP]: { fee: 'swap fee', unit: '$', bandUnit: 'USD' },
  [FeeKind.WITHDRAWAL]: { fee: 'withdrawal fee', unit: '$', bandUnit: 'USD' },
  // Naira on both sides. A naira band pegged to a dollar amount would move
  // every time the exchange rate did, so a ₦50,000 cash-out could change price
  // overnight with nobody having touched the ladder.
  [FeeKind.NGN_WITHDRAWAL]: { fee: 'naira withdrawal fee', unit: '₦', bandUnit: 'NGN' },
};

/** The currency a ladder's rungs are measured in. */
export function bandUnitOf(kind: FeeKind): 'USD' | 'NGN' {
  return NAMES[kind].bandUnit;
}

/**
 * Tiered fees: what a trade pays depends on how big it is.
 *
 * There are three ladders and they are entirely separate. RATE prices buying
 * and selling for naira, in naira per dollar folded into the rate. SWAP prices
 * coin-to-coin, as a flat dollar amount. WITHDRAWAL is what the platform adds
 * to sending a coin out, again in dollars, on top of whatever the chain charges
 * — the two halves of a withdrawal fee are never blended into one line.
 *
 * A coin can charge a tight rate fee and a generous swap fee, and none of the
 * three need break at the same dollar amounts — which is the whole reason they
 * are not one table.
 *
 * Both are set per coin, falling back to a global default, and both are
 * VERSIONED as a set. Editing inserts a whole new schedule rather than mutating
 * bands, because changing one rung of a live schedule would silently rewrite
 * what every earlier trade was charged under.
 */
@Injectable()
export class FeeBandsService {
  private readonly log = new Logger(FeeBandsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Bands must tile the whole range with no gap and no overlap.
   *
   * A gap means some trade size matches nothing and the quote fails with
   * nothing useful to say. An overlap means two rungs match and the price
   * depends on row order, which is not a pricing model.
   */
  validate(kind: FeeKind, bands: BandInput[]): void {
    const name = NAMES[kind].fee;
    const symbol = NAMES[kind].bandUnit === 'NGN' ? '₦' : '$';
    if (bands.length === 0) throw new BadRequestException(`A ${name} ladder needs at least one band`);

    const parsed = bands
      .map((b, i) => ({
        index: i,
        min: dec(b.minAmount),
        max: b.maxAmount === null || b.maxAmount === undefined || b.maxAmount === '' ? null : dec(b.maxAmount),
        value: dec(b.value),
      }))
      .sort((a, b) => a.min.comparedTo(b.min));

    for (const band of parsed) {
      if (band.min.lt(0)) throw new BadRequestException(`A band cannot start below ${symbol}0`);
      if (band.value.lt(0)) {
        throw new BadRequestException(`A ${name} cannot be negative`);
      }
      if (band.max !== null && band.max.lte(band.min)) {
        throw new BadRequestException(
          `Band starting at ${symbol}${band.min.toFixed(2)} ends at or before it starts`,
        );
      }
    }

    // Exactly one open-ended band, and it has to be the last one.
    const openEnded = parsed.filter((b) => b.max === null);
    if (openEnded.length === 0) {
      throw new BadRequestException(
        'The highest band must be open-ended, or trades above it have no price',
      );
    }
    if (openEnded.length > 1) {
      throw new BadRequestException('Only the highest band can be open-ended');
    }
    if (parsed[parsed.length - 1].max !== null) {
      throw new BadRequestException('The open-ended band must be the highest one');
    }

    // Contiguous: each band starts exactly where the previous one ended.
    for (let i = 1; i < parsed.length; i++) {
      const prev = parsed[i - 1];
      const curr = parsed[i];
      if (prev.max === null) continue;
      if (curr.min.lt(prev.max)) {
        throw new BadRequestException(
          `Bands overlap: ${symbol}${curr.min.toFixed(2)} starts inside the band ending at ${symbol}${prev.max.toFixed(2)}`,
        );
      }
      if (curr.min.gt(prev.max)) {
        throw new BadRequestException(
          `Gap between ${symbol}${prev.max.toFixed(2)} and ${symbol}${curr.min.toFixed(2)} — an amount that size would have no price`,
        );
      }
    }
  }

  /** Replace one ladder for one coin, or the global default when assetCode is null. */
  async setSchedule(params: {
    kind: FeeKind;
    assetCode: string | null;
    bands: BandInput[];
    setBy: string;
    note?: string;
    /** Put this coin back on the global default. Writes a marker, not a delete. */
    inherits?: boolean;
  }) {
    if (params.inherits) {
      if (!params.assetCode) {
        // There is nothing above the global ladder to inherit from.
        throw new BadRequestException('The default ladder cannot inherit from anything');
      }
      const marker = await this.prisma.feeSchedule.create({
        data: {
          kind: params.kind,
          assetCode: params.assetCode.toLowerCase(),
          setBy: params.setBy,
          note: params.note ?? null,
          inherits: true,
        },
        include: { bands: true },
      });
      this.log.warn(
        `${params.kind} ladder for ${params.assetCode} returned to the default by ${params.setBy}`,
      );
      return marker;
    }

    this.validate(params.kind, params.bands);

    const sorted = [...params.bands].sort((a, b) => dec(a.minAmount).comparedTo(dec(b.minAmount)));

    const schedule = await this.prisma.feeSchedule.create({
      data: {
        kind: params.kind,
        assetCode: params.assetCode?.toLowerCase() ?? null,
        setBy: params.setBy,
        note: params.note ?? null,
        bands: {
          create: sorted.map((b, i) => ({
            minAmount: dec(b.minAmount).toFixed(),
            maxAmount:
              b.maxAmount === null || b.maxAmount === undefined || b.maxAmount === ''
                ? null
                : dec(b.maxAmount).toFixed(),
            value: dec(b.value).toFixed(),
            sortOrder: i,
          })),
        },
      },
      include: { bands: { orderBy: { sortOrder: 'asc' } } },
    });

    this.log.warn(
      `${params.kind} ladder for ${params.assetCode ?? 'GLOBAL'} replaced by ${params.setBy}: ` +
        sorted.map((b) => `${b.minAmount}-${b.maxAmount ?? '∞'} @ ${b.value}`).join(', '),
    );

    return schedule;
  }

  /** The live ladder of this kind for a coin, falling back to the global one. */
  async currentSchedule(kind: FeeKind, assetCode: string) {
    const code = assetCode.toLowerCase();
    const now = new Date();

    const specific = await this.prisma.feeSchedule.findFirst({
      where: { kind, assetCode: code, effectiveFrom: { lte: now } },
      orderBy: { effectiveFrom: 'desc' },
      include: { bands: { orderBy: { sortOrder: 'asc' } } },
    });
    // An inherit marker is the newest word on this coin, and what it says is
    // "use the default" — so fall through rather than returning an empty ladder.
    if (specific && !specific.inherits) return { schedule: specific, fromGlobal: false };

    const global = await this.prisma.feeSchedule.findFirst({
      where: { kind, assetCode: null, effectiveFrom: { lte: now } },
      orderBy: { effectiveFrom: 'desc' },
      include: { bands: { orderBy: { sortOrder: 'asc' } } },
    });
    return global ? { schedule: global, fromGlobal: true } : null;
  }

  /**
   * Pick the rung an amount falls on.
   *
   * The amount must be in the ladder's own band currency — dollars for the
   * three that price a coin, naira for the one that prices a cash-out. Passing
   * the wrong one silently prices against the wrong rung.
   *
   * Returns null when no ladder of this kind exists at all, so the caller can
   * fall back to the flat value on RateConfig rather than failing the quote.
   */
  async resolve(kind: FeeKind, assetCode: string, amount: Decimal): Promise<ResolvedBand | null> {
    const found = await this.currentSchedule(kind, assetCode);
    if (!found) return null;

    const { schedule, fromGlobal } = found;

    for (const band of schedule.bands) {
      const min = dec(band.minAmount);
      const max = band.maxAmount === null ? null : dec(band.maxAmount);
      // Half-open [min, max) so a value on a boundary belongs to exactly one
      // rung — $100 with bands 10–100 and 100–1000 lands on the second.
      if (amount.gte(min) && (max === null || amount.lt(max))) {
        return {
          scheduleId: schedule.id,
          bandId: band.id,
          minAmount: min,
          maxAmount: max,
          value: dec(band.value),
          fromGlobal,
        };
      }
    }

    // Below the lowest band. Validation guarantees no interior gaps, so this
    // only happens under the floor, where the minimum check already rejects.
    return null;
  }

  private shape(bands: { id: string; minAmount: unknown; maxAmount: unknown; value: unknown }[]) {
    return bands.map((b) => ({
      id: b.id,
      minAmount: dec(b.minAmount as string).toFixed(2),
      maxAmount: b.maxAmount === null ? null : dec(b.maxAmount as string).toFixed(2),
      value: dec(b.value as string).toFixed(2),
    }));
  }

  /** One kind of ladder across every coin, for its admin screen. */
  async listCurrent(kind: FeeKind) {
    const assets = await this.prisma.asset.findMany({
      where: { isListed: true, isFiat: false },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, name: true },
    });

    // '__none__' is not a coin, so this can only match the global ladder.
    const globalFound = await this.currentSchedule(kind, '__none__');

    const rows = await Promise.all(
      assets.map(async (a) => {
        const found = await this.currentSchedule(kind, a.code);
        return {
          asset: a.code,
          name: a.name,
          usesGlobal: found?.fromGlobal ?? true,
          scheduleId: found?.schedule.id ?? null,
          effectiveFrom: found?.schedule.effectiveFrom ?? null,
          setBy: found?.schedule.setBy ?? null,
          // What it is charging right now — the global rungs when it inherits,
          // so the table shows a real price for every coin rather than a blank.
          bands: this.shape(found?.schedule.bands ?? []),
        };
      }),
    );

    return {
      kind,
      unit: NAMES[kind].unit,
      /** What the rungs are measured in, so the editor can label its columns. */
      bandUnit: NAMES[kind].bandUnit,
      global: globalFound
        ? {
            scheduleId: globalFound.schedule.id,
            effectiveFrom: globalFound.schedule.effectiveFrom,
            setBy: globalFound.schedule.setBy,
            bands: this.shape(globalFound.schedule.bands),
          }
        : null,
      assets: rows,
    };
  }

  /** History for one ladder, so a past trade can be explained. */
  async history(kind: FeeKind, assetCode: string | null, limit = 20) {
    return this.prisma.feeSchedule.findMany({
      where: { kind, assetCode: assetCode?.toLowerCase() ?? null },
      orderBy: { effectiveFrom: 'desc' },
      take: limit,
      include: { bands: { orderBy: { sortOrder: 'asc' } } },
    });
  }

  /** Preview: what would a trade of this size actually pay, on both ladders? */
  async preview(assetCode: string, usdValue: string) {
    const value = dec(usdValue);
    const [rate, swap] = await Promise.all([
      this.resolve(FeeKind.RATE, assetCode, value),
      this.resolve(FeeKind.SWAP, assetCode, value),
    ]);

    return {
      asset: assetCode,
      usdValue: value.toFixed(2),
      rate: rate
        ? {
            minAmount: rate.minAmount.toFixed(2),
            maxAmount: rate.maxAmount?.toFixed(2) ?? null,
            ngnPerUsd: rate.value.toFixed(2),
            marginNgn: value.mul(rate.value).toFixed(2),
            fromGlobal: rate.fromGlobal,
          }
        : null,
      swap: swap
        ? {
            minAmount: swap.minAmount.toFixed(2),
            maxAmount: swap.maxAmount?.toFixed(2) ?? null,
            feeUsd: swap.value.toFixed(2),
            fromGlobal: swap.fromGlobal,
          }
        : null,
    };
  }

  static readonly ZERO = ZERO;
}
