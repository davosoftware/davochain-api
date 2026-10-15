import { RatesService } from './rates.service';
import { dec } from '../common/money';

/**
 * M11 (PROJECT_REVIEW; decision 15 Oct 2026): a SELL is priced from what Quidax
 * would actually pay for the coin (a coin -> naira quotation), not from its
 * buying price. With one buy-side reference, a spread wider than our margin
 * made every coin bought from a customer worth less than we paid for it.
 */
function service() {
  const quotes: Record<string, (from?: string) => { from_amount: string; to_amount: string }> = {
    // Buying: ₦1,000,000 buys 0.01 BTC (₦100,000,000 per BTC); ₦1,000,000 buys 625 USDT (₦1,600 per $).
    'ngn->btc': () => ({ from_amount: '1000000', to_amount: '0.01' }),
    'ngn->usdt': () => ({ from_amount: '1000000', to_amount: '625' }),
    // Selling: Quidax pays 2% less for BTC than it charges.
    'btc->ngn': (from) => ({ from_amount: from!, to_amount: dec(from!).mul('98000000').toFixed() }),
    'usdt->ngn': (from) => ({ from_amount: from!, to_amount: dec(from!).mul('1580').toFixed() }),
  };
  const seen: string[] = [];
  const quidax = {
    temporaryQuotation: jest.fn(async (_u: string, i: { from_currency: string; to_currency: string; from_amount?: string }) => {
      const key = `${i.from_currency}->${i.to_currency}`;
      seen.push(`${key} ${i.from_amount}`);
      return { id: 'q', ...quotes[key](i.from_amount) };
    }),
  };
  const prisma = { rateSnapshot: { create: jest.fn(async () => ({})) } };
  const svc = new RatesService(prisma as never, quidax as never, { get: () => 0 } as never);
  return { svc, seen };
}

describe('M11: the sell reference is what Quidax would pay', () => {
  it('BTC: ₦ per $ for selling is lower than for buying, by Quidax\'s spread', async () => {
    const { svc } = service();
    const buy = await svc.price('btc');
    const sell = await svc.sellPrice('btc');
    expect(buy.ngnPerUsd.toFixed()).toBe('1600');
    // ₦98,000,000 per BTC at $62,500 per BTC = ₦1,568 per $.
    expect(sell.ngnPerUsd.toFixed()).toBe('1568');
    expect(sell.priceUsd.toFixed()).toBe(buy.priceUsd.toFixed());
  });

  it('asks Quidax for a coin -> naira quote sized like the buy probe (about ₦1,000,000)', async () => {
    const { svc, seen } = service();
    await svc.sellPrice('btc');
    expect(seen).toContain('btc->ngn 0.01');
  });

  it('USDT works the same way', async () => {
    const { svc } = service();
    expect((await svc.sellPrice('usdt')).ngnPerUsd.toFixed()).toBe('1580');
  });
});
