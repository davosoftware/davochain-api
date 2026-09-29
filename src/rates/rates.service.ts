import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateConfig } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuidaxClient } from '../quidax/quidax.client';
import { SingleFlight } from '../quidax/rate-limiter';
import { Decimal, dec } from '../common/money';
import type { QuidaxSwapQuotation } from '../quidax/quidax.types';

export interface PricePoint {
  assetCode: string;
  /** Quidax naira per USD, implied by a quotation on the real pair. */
  ngnPerUsd: Decimal;
  /** USD price of one unit of the coin. */
  priceUsd: Decimal;
  capturedAt: Date;
}

const NGN = 'ngn';
const USD_PROXY = 'usdt'; // the market's actual dollar

@Injectable()
export class RatesService {
  private readonly log = new Logger(RatesService.name);

  /**
   * Coalesces concurrent quotes for the same coin into one upstream call.
   *
   * One quote is one Quidax call and the budget is 300/min for the whole
   * platform. A user requoting every 12s is 5 calls a minute by themselves —
   * fifty such users would consume the entire allowance. With a 3s window a
   * thousand users watching BTC generate ~20 calls a minute instead, and each
   * still sees a live quote with its own fresh countdown.
   */
  private readonly flight: SingleFlight<PricePoint>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly quidax: QuidaxClient,
    private readonly config: ConfigService,
  ) {
    const ttl = (this.config.get<number>('RATE_CACHE_TTL_SECONDS') ?? 3) * 1000;
    this.flight = new SingleFlight<PricePoint>(ttl);
  }

  /** The gate live right now for a coin. Versioned — always the newest row. */
  async rateConfig(assetCode: string): Promise<RateConfig> {
    const specific = await this.prisma.rateConfig.findFirst({
      where: { assetCode: assetCode.toLowerCase(), effectiveFrom: { lte: new Date() } },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (specific) return specific;

    const global = await this.prisma.rateConfig.findFirst({
      where: { assetCode: null, effectiveFrom: { lte: new Date() } },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (!global) {
      throw new Error(`No rate config for ${assetCode} and no GLOBAL fallback exists`);
    }
    return global;
  }

  /**
   * Price a coin, from a non-binding quotation on the pair we would actually
   * trade — not from the ticker.
   *
   * The ticker is last-traded on the order book; a swap executes against the
   * instant-swap book, and those are not the same number.
   */
  async price(assetCode: string): Promise<PricePoint> {
    const code = assetCode.toLowerCase();
    return this.flight.run(code, () => this.fetchPrice(code));
  }

  private async fetchPrice(code: string): Promise<PricePoint> {
    if (code === NGN) {
      const usdt = await this.quidaxQuote(NGN, USD_PROXY, '100000');
      const ngnPerUsd = dec(usdt.from_amount).div(dec(usdt.to_amount));
      return this.persist({
        assetCode: NGN,
        ngnPerUsd,
        priceUsd: dec(1).div(ngnPerUsd),
        capturedAt: new Date(),
      });
    }

    // NGN -> coin on the real pair, plus the coin's dollar price, so the
    // NGN/USD leg the admin gates is derived rather than assumed.
    const probeNgn = '1000000';
    const [toCoin, ngnToUsd] = await Promise.all([
      this.quidaxQuote(NGN, code, probeNgn),
      code === USD_PROXY ? Promise.resolve(null) : this.quidaxQuote(NGN, USD_PROXY, probeNgn),
    ]);

    const ngnPerCoin = dec(toCoin.from_amount).div(dec(toCoin.to_amount));
    const ngnPerUsd = ngnToUsd
      ? dec(ngnToUsd.from_amount).div(dec(ngnToUsd.to_amount))
      : ngnPerCoin;
    const priceUsd = ngnPerCoin.div(ngnPerUsd);

    return this.persist({ assetCode: code, ngnPerUsd, priceUsd, capturedAt: new Date() });
  }

  private async quidaxQuote(
    from: string,
    to: string,
    fromAmount: string,
  ): Promise<QuidaxSwapQuotation> {
    return this.quidax.temporaryQuotation('me', {
      from_currency: from,
      to_currency: to,
      from_amount: fromAmount,
    });
  }

  /** Snapshots are what a disputed trade is reconstructed from. */
  private async persist(point: PricePoint): Promise<PricePoint> {
    await this.prisma.rateSnapshot
      .create({
        data: {
          assetCode: point.assetCode,
          ngnPerUsd: point.ngnPerUsd.toFixed(),
          priceUsd: point.priceUsd.toFixed(),
        },
      })
      .catch((e: Error) => this.log.warn(`Snapshot failed for ${point.assetCode}: ${e.message}`));
    return point;
  }

  /**
   * The rate shown to a user.
   *
   *   buy   R = R_qx + gate    (they pay more naira per dollar)
   *   sell  R = R_qx − gate    (they receive less)
   *
   * The gate is the entire margin, and the app shows a ₦0 fee — so the rate on
   * screen has to be exactly the rate that settles. There is no fee line for a
   * discrepancy to hide in.
   */
  displayRate(side: 'buy' | 'sell', ngnPerUsd: Decimal, gate: Decimal): Decimal {
    return side === 'buy' ? ngnPerUsd.plus(gate) : ngnPerUsd.minus(gate);
  }

  /** Margin on a trade, in naira: the USD notional times the gate. */
  marginNgn(usdValue: Decimal, gate: Decimal): Decimal {
    return usdValue.mul(gate);
  }
}
