import { Injectable, Logger } from '@nestjs/common';
import { RatesService } from '../rates/rates.service';
import { AssetsService } from '../assets/assets.service';
import { SystemFlagsService } from '../common/system-flags.service';
import { SingleFlight } from '../quidax/rate-limiter';
import { Decimal, dec } from '../common/money';
import { QuotesService } from './quotes.service';

/** One side of a coin's price: naira per dollar of it, and naira for one whole coin. */
export interface BoardSide {
  ngnPerUsd: string;
  ngnPerUnit: string;
}

export interface BoardCoin {
  code: string;
  name: string;
  /** False when its price could not be fetched just now; the prices are then null. */
  available: boolean;
  /** False while trading in this coin (or all trading) is paused by an admin. */
  tradable: boolean;
  priceUsd: string | null;
  /** What a customer pays to buy. */
  buy: BoardSide | null;
  /** What a customer receives to sell. */
  sell: BoardSide | null;
}

export interface RateBoard {
  updatedAt: string;
  refreshSeconds: number;
  /** The trade size the margins are taken at; a real quote can differ a little. */
  referenceUsd: string;
  coins: BoardCoin[];
}

/** One shared copy for everybody, so a crowd watching prices costs Quidax nothing extra. */
const REFRESH_SECONDS = 30;
/** Margins depend on trade size; the list shows a typical trade (decision 28 Oct 2026). */
const REFERENCE_USD = dec('100');

/**
 * GET /v1/rates: the public price list (markets screen, welcome screen, the
 * website). Built from the same pieces as a quote — Quidax's live buying and
 * selling prices plus our buy and sell margins — so the list and the trade
 * agree. The exact price is still the quote's, at the quote step.
 */
@Injectable()
export class RateBoardService {
  private readonly log = new Logger(RateBoardService.name);
  private readonly flight = new SingleFlight<RateBoard>(REFRESH_SECONDS * 1000);

  constructor(
    private readonly rates: RatesService,
    private readonly quotes: QuotesService,
    private readonly assets: AssetsService,
    private readonly flags: SystemFlagsService,
  ) {}

  board(): Promise<RateBoard> {
    return this.flight.run('board', () => this.build());
  }

  private async build(): Promise<RateBoard> {
    const listed = await this.assets.listed();
    const coins = await Promise.all(listed.map((a) => this.coin(a.code, a.name)));
    return {
      updatedAt: new Date().toISOString(),
      refreshSeconds: REFRESH_SECONDS,
      referenceUsd: REFERENCE_USD.toFixed(),
      coins,
    };
  }

  private async coin(code: string, name: string): Promise<BoardCoin> {
    const tradable = await this.flags
      .assertTradingAllowed(code)
      .then(() => true)
      .catch(() => false);
    try {
      const [cfg, buyPrice, sellPrice] = await Promise.all([
        this.rates.rateConfig(code),
        this.rates.price(code),
        this.rates.sellPrice(code),
      ]);
      const [buyGate, sellGate] = await Promise.all([
        this.quotes.gateFor(code, REFERENCE_USD, cfg),
        this.quotes.sellGateFor(code, REFERENCE_USD, cfg),
      ]);
      const rBuy = this.rates.displayRate('buy', buyPrice.ngnPerUsd, buyGate);
      const rSell = Decimal.max(this.rates.displayRate('sell', sellPrice.ngnPerUsd, sellGate), 0);
      return {
        code,
        name,
        available: true,
        tradable,
        priceUsd: buyPrice.priceUsd.toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toFixed(),
        buy: side(rBuy, buyPrice.priceUsd),
        sell: side(rSell, sellPrice.priceUsd),
      };
    } catch (e) {
      this.log.warn(`No price for ${code} on the rate board: ${(e as Error).message}`);
      return { code, name, available: false, tradable, priceUsd: null, buy: null, sell: null };
    }
  }
}

function side(ngnPerUsd: Decimal, priceUsd: Decimal): BoardSide {
  return {
    ngnPerUsd: ngnPerUsd.toFixed(2, Decimal.ROUND_HALF_UP),
    ngnPerUnit: ngnPerUsd.mul(priceUsd).toFixed(2, Decimal.ROUND_HALF_UP),
  };
}
