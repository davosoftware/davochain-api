import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QuoteSide, RateQuote } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RatesService } from '../rates/rates.service';
import { FeeKind } from '@prisma/client';
import { FeeBandsService } from '../rates/fee-bands.service';
import { AssetsService } from '../assets/assets.service';
import { LedgerService } from '../ledger/ledger.service';
import { SystemFlagsService } from '../common/system-flags.service';
import { Decimal, ZERO, dec, floorToStep, str } from '../common/money';

export interface QuoteView {
  quoteId: string;
  side: QuoteSide;
  fromAsset: string;
  toAsset: string;
  fromAmount: string;
  toAmount: string;
  /** NGN per USD, with the gate already applied. This is what settles. */
  rate: string;
  fee: string;
  feeAsset: string | null;
  minimum: string;
  maximum: string;
  expiresAt: string;
  ttlSeconds: number;
  /** What the user can actually spend right now — the screen shows this. */
  availableBalance: string;
}

@Injectable()
export class QuotesService {
  private readonly log = new Logger(QuotesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rates: RatesService,
    private readonly feeBands: FeeBandsService,
    private readonly assets: AssetsService,
    private readonly ledger: LedgerService,
    private readonly flags: SystemFlagsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The gate for a trade of this size.
   *
   * Falls back to the flat gate on RateConfig when no band schedule exists, so
   * an install that has never configured a ladder still prices correctly rather
   * than failing every quote.
   */
  private async gateFor(
    assetCode: string,
    usdValue: Decimal,
    cfg: { gateNgnPerUsd: unknown },
  ): Promise<Decimal> {
    const band = await this.feeBands.resolve(FeeKind.RATE, assetCode, usdValue);
    return band ? band.value : dec(cfg.gateNgnPerUsd as string);
  }

  /**
   * BUY — user spends naira on a coin.
   *
   *   R_buy    = R_qx + gate
   *   usdValue = ngn / R_buy
   *   coinOut  = usdValue / priceUsd, ROUNDED DOWN to the transfer step
   *
   * Then the naira cost is recomputed FROM the rounded coin amount, so nothing
   * evaporates in the rounding and the receipt reconciles exactly.
   */
  async quoteBuy(userId: string, assetCode: string, ngnAmount: Decimal): Promise<QuoteView> {
    const code = assetCode.toLowerCase();
    await this.flags.assertTradingAllowed(code);

    const asset = await this.assets.require(code);
    const [cfg, price] = await Promise.all([this.rates.rateConfig(code), this.rates.price(code)]);

    /*
     * A buy is circular: the gate depends on the trade's USD size, but the size
     * depends on the rate, which depends on the gate.
     *
     * Resolve it in two passes. The first estimate uses the raw rate, which
     * always OVERSTATES the size slightly (a positive gate makes each dollar
     * cost more naira, so the true figure is smaller). Near a band boundary
     * that could pick too high a rung, so we re-resolve from the true value and
     * recompute once if the band actually changed. It converges immediately —
     * a second correction would have to move the value by more than the gate,
     * which is a fraction of a percent.
     */
    const estimatedUsd = ngnAmount.div(price.ngnPerUsd);
    let gate = await this.gateFor(code, estimatedUsd, cfg);
    let rBuy = this.rates.displayRate('buy', price.ngnPerUsd, gate);
    let usdValue = ngnAmount.div(rBuy);

    const settledGate = await this.gateFor(code, usdValue, cfg);
    if (!settledGate.equals(gate)) {
      gate = settledGate;
      rBuy = this.rates.displayRate('buy', price.ngnPerUsd, gate);
      usdValue = ngnAmount.div(rBuy);
    }

    const gross = usdValue.div(price.priceUsd);
    const coinOut = floorToStep(gross, asset.transferStep);
    if (coinOut.lte(0)) {
      throw new BadRequestException('Amount is too small to trade in this coin');
    }

    // Re-price from the rounded amount — this is what makes rounding free.
    const settledNgn = coinOut.mul(price.priceUsd).mul(rBuy);

    await this.assertWithinLimits(code, usdValue, cfg, asset, price.priceUsd);
    this.assets.assertTransferable(asset, coinOut);

    const balance = await this.ledger.getBalance(userId, 'ngn');
    if (balance.available.lt(settledNgn)) {
      throw new BadRequestException(
        `Insufficient naira balance. You have ₦${str(balance.available, 2)}.`,
      );
    }

    return this.persist({
      userId,
      side: QuoteSide.BUY,
      fromAsset: 'ngn',
      toAsset: code,
      fromAmount: settledNgn,
      toAmount: coinOut,
      displayedRate: rBuy,
      quidaxRate: price.ngnPerUsd,
      gate,
      fee: ZERO,
      feeAsset: null,
      rateConfigId: cfg.id,
      minimumUsd: await this.assets.minimumUsd(asset, price.priceUsd, dec(cfg.floorUsd)),
      maximumUsd: dec(cfg.maxTradeUsd),
      priceUsd: price.priceUsd,
      rate: rBuy,
      availableBalance: balance.available,
      scale: 2,
      usdValue,
      feeUsd: ZERO,
    });
  }

  /** SELL — mirror of buy: the gate is subtracted instead of added. */
  async quoteSell(userId: string, assetCode: string, coinAmount: Decimal): Promise<QuoteView> {
    const code = assetCode.toLowerCase();
    await this.flags.assertTradingAllowed(code);

    const asset = await this.assets.require(code);
    const [cfg, price] = await Promise.all([this.rates.rateConfig(code), this.rates.price(code)]);

    // No circularity on a sell: the USD size comes straight from the coin
    // amount, so the band resolves in one pass.
    const amountIn = floorToStep(coinAmount, asset.transferStep);
    const usdValue = amountIn.mul(price.priceUsd);

    const gate = await this.gateFor(code, usdValue, cfg);
    const rSell = this.rates.displayRate('sell', price.ngnPerUsd, gate);
    const ngnOut = usdValue.mul(rSell);

    await this.assertWithinLimits(code, usdValue, cfg, asset, price.priceUsd);
    this.assets.assertTransferable(asset, amountIn);

    const balance = await this.ledger.getBalance(userId, code);
    if (balance.available.lt(amountIn)) {
      throw new BadRequestException(
        `Insufficient ${code.toUpperCase()} balance. You have ${str(balance.available, asset.displayScale)}.`,
      );
    }

    return this.persist({
      userId,
      side: QuoteSide.SELL,
      fromAsset: code,
      toAsset: 'ngn',
      fromAmount: amountIn,
      toAmount: ngnOut,
      displayedRate: rSell,
      quidaxRate: price.ngnPerUsd,
      gate,
      fee: ZERO,
      feeAsset: null,
      rateConfigId: cfg.id,
      minimumUsd: await this.assets.minimumUsd(asset, price.priceUsd, dec(cfg.floorUsd)),
      maximumUsd: dec(cfg.maxTradeUsd),
      priceUsd: price.priceUsd,
      rate: rSell,
      availableBalance: balance.available,
      usdValue,
      feeUsd: ZERO,
      scale: asset.displayScale,
    });
  }

  /**
   * SWAP — coin to coin. Different mechanism, different fee.
   *
   * No naira leg, so the per-dollar gate does not apply. A flat USD fee is
   * taken from the OUTPUT and accrues as a receivable; the swap itself runs
   * inside the user's own sub-account, so no transfer minimum applies to it.
   */
  async quoteSwap(
    userId: string,
    fromCode: string,
    toCode: string,
    fromAmount: Decimal,
  ): Promise<QuoteView> {
    const from = fromCode.toLowerCase();
    const to = toCode.toLowerCase();
    if (from === to) throw new BadRequestException('Choose two different coins');

    await this.flags.assertTradingAllowed(from);
    await this.flags.assertTradingAllowed(to);

    const [fromAsset, toAsset] = await Promise.all([
      this.assets.require(from),
      this.assets.require(to),
    ]);
    const [cfg, fromPrice, toPrice] = await Promise.all([
      this.rates.rateConfig(from),
      this.rates.price(from),
      this.rates.price(to),
    ]);

    const amountIn = floorToStep(fromAmount, fromAsset.transferStep);
    const usdValue = amountIn.mul(fromPrice.priceUsd);

    // The swap fee has its own ladder, priced on the coin being sold. A flat
    // $2 is 10% of a $20 swap and 0.04% of a $5,000 one, so it bands like the
    // rate fee does — but on its own boundaries. Falls back to the flat config
    // when no swap ladder is configured at all.
    const swapBand = await this.feeBands.resolve(FeeKind.SWAP, from, usdValue);
    const feeUsd = swapBand?.value ?? dec(cfg.swapFeeUsd);
    if (usdValue.lte(feeUsd.mul(2))) {
      throw new BadRequestException(
        `Minimum swap is $${feeUsd.mul(2).toFixed(2)} worth — the $${feeUsd.toFixed(2)} fee would take too large a share`,
      );
    }

    const grossOut = usdValue.div(toPrice.priceUsd);
    const feeInToAsset = feeUsd.div(toPrice.priceUsd);
    const netOut = floorToStep(grossOut.minus(feeInToAsset), toAsset.transferStep);
    if (netOut.lte(0)) throw new BadRequestException('Amount is too small to swap');

    const balance = await this.ledger.getBalance(userId, from);
    if (balance.available.lt(amountIn)) {
      throw new BadRequestException(
        `Insufficient ${from.toUpperCase()} balance. You have ${str(balance.available, fromAsset.displayScale)}.`,
      );
    }

    return this.persist({
      userId,
      side: QuoteSide.SWAP,
      fromAsset: from,
      toAsset: to,
      fromAmount: amountIn,
      toAmount: netOut,
      displayedRate: grossOut.div(amountIn),
      quidaxRate: grossOut.div(amountIn),
      gate: ZERO,
      fee: feeInToAsset,
      feeAsset: to,
      rateConfigId: cfg.id,
      minimumUsd: feeUsd.mul(2),
      maximumUsd: dec(cfg.maxTradeUsd),
      priceUsd: fromPrice.priceUsd,
      rate: grossOut.div(amountIn),
      availableBalance: balance.available,
      scale: fromAsset.displayScale,
      usdValue,
      feeUsd,
    });
  }

  private async assertWithinLimits(
    code: string,
    usdValue: Decimal,
    cfg: { floorUsd: unknown; maxTradeUsd: unknown },
    asset: { transferMin: unknown; transferStep: unknown; code: string },
    priceUsd: Decimal,
  ): Promise<void> {
    const min = await this.assets.minimumUsd(asset as never, priceUsd, dec(cfg.floorUsd as string));
    if (usdValue.lt(min)) {
      throw new BadRequestException(
        `Minimum ${code.toUpperCase()} trade is $${min.toFixed(2)}. ` +
          `This one is worth $${usdValue.toFixed(2)}.`,
      );
    }
    const max = dec(cfg.maxTradeUsd as string);
    if (usdValue.gt(max)) {
      throw new BadRequestException(`Maximum single trade is $${max.toFixed(2)}.`);
    }
  }

  private async persist(input: {
    userId: string;
    side: QuoteSide;
    fromAsset: string;
    toAsset: string;
    fromAmount: Decimal;
    toAmount: Decimal;
    displayedRate: Decimal;
    quidaxRate: Decimal;
    gate: Decimal;
    fee: Decimal;
    feeAsset: string | null;
    rateConfigId: string;
    minimumUsd: Decimal;
    maximumUsd: Decimal;
    priceUsd: Decimal;
    rate: Decimal;
    availableBalance: Decimal;
    scale: number;
    /** What this trade is worth in dollars, priced now. */
    usdValue: Decimal;
    /** The fee in dollars, whatever asset it is actually charged in. */
    feeUsd: Decimal;
  }): Promise<QuoteView> {
    const ttl = this.config.get<number>('QUOTE_TTL_SECONDS') ?? 12;
    const expiresAt = new Date(Date.now() + ttl * 1000);

    const quote = await this.prisma.rateQuote.create({
      data: {
        userId: input.userId,
        side: input.side,
        fromAsset: input.fromAsset,
        toAsset: input.toAsset,
        fromAmount: input.fromAmount.toFixed(),
        toAmount: input.toAmount.toFixed(),
        displayedRate: input.displayedRate.toFixed(),
        quidaxRate: input.quidaxRate.toFixed(),
        gateApplied: input.gate.toFixed(),
        feeAmount: input.fee.toFixed(),
        feeAsset: input.feeAsset,
        usdValue: input.usdValue.toFixed(),
        feeUsd: input.feeUsd.toFixed(),
        rateConfigId: input.rateConfigId,
        expiresAt,
      },
    });

    return {
      quoteId: quote.id,
      side: input.side,
      fromAsset: input.fromAsset,
      toAsset: input.toAsset,
      fromAmount: str(input.fromAmount, input.fromAsset === 'ngn' ? 2 : 8),
      toAmount: str(input.toAmount, input.toAsset === 'ngn' ? 2 : 8),
      rate: str(input.rate, 4),
      fee: str(input.fee, 8),
      feeAsset: input.feeAsset,
      minimum: input.minimumUsd.toFixed(2),
      maximum: input.maximumUsd.toFixed(2),
      expiresAt: expiresAt.toISOString(),
      ttlSeconds: ttl,
      availableBalance: str(input.availableBalance, input.scale),
    };
  }

  /**
   * Consume a quote for execution.
   *
   * Refuses an expired one outright — the Continue button was already disabled,
   * so reaching here means a replayed request. Single use, enforced by the
   * consumedAt stamp.
   */
  async consume(userId: string, quoteId: string): Promise<RateQuote> {
    const quote = await this.prisma.rateQuote.findUnique({ where: { id: quoteId } });
    if (!quote || quote.userId !== userId) throw new NotFoundException('Quote not found');
    if (quote.consumedAt) throw new BadRequestException('This quote has already been used');

    const hardExpiry = this.config.get<number>('QUOTE_HARD_EXPIRY_SECONDS') ?? 30;
    const ageSeconds = (Date.now() - quote.createdAt.getTime()) / 1000;
    if (quote.expiresAt < new Date() || ageSeconds > hardExpiry) {
      throw new BadRequestException('The rate has expired. Please refresh and try again.');
    }

    const claimed = await this.prisma.rateQuote.updateMany({
      where: { id: quoteId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (claimed.count === 0) throw new BadRequestException('This quote has already been used');

    return quote;
  }
}
