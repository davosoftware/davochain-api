import { Injectable } from '@nestjs/common';
import { FeeKind } from '@prisma/client';
import { RatesService } from './rates.service';
import { FeeBandsService } from './fee-bands.service';
import { Decimal, dec } from '../common/money';

export interface MarginInForce {
  ngnPerUsd: string;
  source: 'sell ladder' | 'buy ladder' | 'buy ladder (no sell ladder set)' | 'flat rate setting';
}

/**
 * What a margin setter needs on one screen (M11): Quidax's buying and selling
 * prices for a coin, the spread between them, the margin actually in force on
 * each side and where it comes from, and the rates a customer gets.
 *
 * The margin order is the one QuotesService prices with: the sell margin is
 * the SELL_RATE ladder, else the buy (RATE) ladder, else the flat gate.
 */
@Injectable()
export class PriceReferenceService {
  constructor(
    private readonly rates: RatesService,
    private readonly feeBands: FeeBandsService,
  ) {}

  async reference(assetCode: string, usdValue: string) {
    const code = assetCode.toLowerCase();
    const usd = dec(usdValue);
    const [cfg, buy, sell, rateBand, sellBand] = await Promise.all([
      this.rates.rateConfig(code),
      this.rates.price(code),
      this.rates.sellPrice(code),
      this.feeBands.resolve(FeeKind.RATE, code, usd),
      this.feeBands.resolve(FeeKind.SELL_RATE, code, usd),
    ]);
    const flat = dec(cfg.gateNgnPerUsd as unknown as string);
    const buyMargin: { value: Decimal; source: MarginInForce['source'] } = rateBand
      ? { value: rateBand.value, source: 'buy ladder' }
      : { value: flat, source: 'flat rate setting' };
    const sellMargin: { value: Decimal; source: MarginInForce['source'] } = sellBand
      ? { value: sellBand.value, source: 'sell ladder' }
      : rateBand
        ? { value: rateBand.value, source: 'buy ladder (no sell ladder set)' }
        : { value: flat, source: 'flat rate setting' };

    return {
      asset: code,
      usdValue: usd.toFixed(2),
      quidaxBuyNgnPerUsd: buy.ngnPerUsd.toFixed(2),
      quidaxSellNgnPerUsd: sell.ngnPerUsd.toFixed(2),
      quidaxSpreadNgnPerUsd: buy.ngnPerUsd.minus(sell.ngnPerUsd).toFixed(2),
      buyMargin: { ngnPerUsd: buyMargin.value.toFixed(2), source: buyMargin.source } as MarginInForce,
      sellMargin: { ngnPerUsd: sellMargin.value.toFixed(2), source: sellMargin.source } as MarginInForce,
      customerBuyNgnPerUsd: buy.ngnPerUsd.plus(buyMargin.value).toFixed(2),
      customerSellNgnPerUsd: sell.ngnPerUsd.minus(sellMargin.value).toFixed(2),
    };
  }
}
