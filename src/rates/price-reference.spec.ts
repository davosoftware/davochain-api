import { FeeKind } from '@prisma/client';
import { PriceReferenceService } from './price-reference.service';
import { dec } from '../common/money';

/**
 * M11 (decision 15 Oct 2026): whoever sets the margins sees Quidax's buy and
 * sell prices next to them, which margin is actually in force (and where it
 * comes from), and the rates a customer will get.
 */
function build(bands: Partial<Record<FeeKind, string>>) {
  const rates = {
    rateConfig: jest.fn(async () => ({ gateNgnPerUsd: '20' })),
    price: jest.fn(async () => ({ ngnPerUsd: dec('1600'), priceUsd: dec('62500') })),
    sellPrice: jest.fn(async () => ({ ngnPerUsd: dec('1568'), priceUsd: dec('62500') })),
  };
  const feeBands = {
    resolve: jest.fn(async (kind: FeeKind) => (bands[kind] === undefined ? null : { value: dec(bands[kind]!), minAmount: dec(0), maxAmount: null, fromGlobal: false })),
  };
  return new PriceReferenceService(rates as never, feeBands as never);
}

describe('M11: the price reference shown beside the margins', () => {
  it('with both ladders set', async () => {
    const r = await build({ RATE: '20', SELL_RATE: '30' }).reference('btc', '500');
    expect(r).toEqual({
      asset: 'btc',
      usdValue: '500.00',
      quidaxBuyNgnPerUsd: '1600.00',
      quidaxSellNgnPerUsd: '1568.00',
      quidaxSpreadNgnPerUsd: '32.00',
      buyMargin: { ngnPerUsd: '20.00', source: 'buy ladder' },
      sellMargin: { ngnPerUsd: '30.00', source: 'sell ladder' },
      customerBuyNgnPerUsd: '1620.00',
      customerSellNgnPerUsd: '1538.00',
    });
  });

  it('says when the sell margin is borrowed from the buy ladder, or from the flat gate', async () => {
    expect((await build({ RATE: '25' }).reference('btc', '500')).sellMargin).toEqual({ ngnPerUsd: '25.00', source: 'buy ladder (no sell ladder set)' });
    expect((await build({}).reference('btc', '500')).sellMargin).toEqual({ ngnPerUsd: '20.00', source: 'flat rate setting' });
    expect((await build({}).reference('btc', '500')).buyMargin).toEqual({ ngnPerUsd: '20.00', source: 'flat rate setting' });
  });
});
