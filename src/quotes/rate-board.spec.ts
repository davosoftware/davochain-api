import { ForbiddenException } from '@nestjs/common';
import { RateBoardService } from './rate-board.service';
import { dec } from '../common/money';

/**
 * GET /v1/rates (28 Oct 2026): the public price list for the app's markets
 * screen. Each coin's naira buy and sell price for a typical $100 trade,
 * worked out exactly as a quote works it out, refreshed at most every 30 s.
 */
function build(opts: { failing?: string[]; paused?: string[]; buyGate?: string; sellGate?: string } = {}) {
  const calls = { price: 0, sellPrice: 0, gateUsd: [] as string[] };
  const prices: Record<string, { priceUsd: string; buy: string; sell: string }> = {
    btc: { priceUsd: '60000.0000000000132605111', buy: '1500', sell: '1480' },
    usdt: { priceUsd: '1', buy: '1500', sell: '1490' },
  };
  const rates = {
    rateConfig: jest.fn(async () => ({ gateNgnPerUsd: '20' })),
    price: jest.fn(async (code: string) => {
      calls.price++;
      if (opts.failing?.includes(code)) throw new Error('Quidax down');
      return { assetCode: code, ngnPerUsd: dec(prices[code].buy), priceUsd: dec(prices[code].priceUsd), capturedAt: new Date() };
    }),
    sellPrice: jest.fn(async (code: string) => {
      calls.sellPrice++;
      if (opts.failing?.includes(code)) throw new Error('Quidax down');
      return { assetCode: code, ngnPerUsd: dec(prices[code].sell), priceUsd: dec(prices[code].priceUsd), capturedAt: new Date() };
    }),
    displayRate: (side: 'buy' | 'sell', r: ReturnType<typeof dec>, g: ReturnType<typeof dec>) => (side === 'buy' ? r.plus(g) : r.minus(g)),
  };
  const quotes = {
    gateFor: jest.fn(async (_code: string, usd: ReturnType<typeof dec>) => {
      calls.gateUsd.push(usd.toFixed());
      return dec(opts.buyGate ?? '20');
    }),
    sellGateFor: jest.fn(async () => dec(opts.sellGate ?? '15')),
  };
  const assets = {
    listed: jest.fn(async () => [
      { code: 'btc', name: 'Bitcoin', displayScale: 8 },
      { code: 'usdt', name: 'Tether', displayScale: 2 },
    ]),
  };
  const flags = {
    assertTradingAllowed: jest.fn(async (code: string) => {
      if (opts.paused?.includes(code)) throw new ForbiddenException('paused');
    }),
  };
  const svc = new RateBoardService(rates as never, quotes as never, assets as never, flags as never);
  return { svc, calls };
}

describe('GET /v1/rates: the public price list', () => {
  it('prices each coin in naira for a $100 trade, buy and sell, like a quote', async () => {
    const { svc, calls } = build();
    const board = await svc.board();
    const btc = board.coins.find((c) => c.code === 'btc')!;
    // Buy: ₦1,500/$ + ₦20 margin = ₦1,520/$; 1 BTC = $60,000 × 1,520.
    expect(btc).toMatchObject({
      code: 'btc',
      name: 'Bitcoin',
      available: true,
      tradable: true,
      priceUsd: '60000',
      buy: { ngnPerUsd: '1520.00', ngnPerUnit: '91200000.00' },
      // Sell: Quidax's selling ₦1,480/$ − ₦15 sell margin = ₦1,465/$.
      sell: { ngnPerUsd: '1465.00', ngnPerUnit: '87900000.00' },
    });
    expect(board.referenceUsd).toBe('100');
    expect(board.refreshSeconds).toBe(30);
    expect(calls.gateUsd).toEqual(['100', '100']);
  });

  it('shows the dollar price without division noise (at most 8 decimals)', async () => {
    const { svc } = build();
    expect((await svc.board()).coins[0].priceUsd).toBe('60000');
  });

  it('keeps the order of the coin list', async () => {
    const { svc } = build();
    expect((await svc.board()).coins.map((c) => c.code)).toEqual(['btc', 'usdt']);
  });

  it('one coin failing does not take the list down', async () => {
    const { svc } = build({ failing: ['btc'] });
    const board = await svc.board();
    expect(board.coins.find((c) => c.code === 'btc')).toMatchObject({ available: false, priceUsd: null, buy: null, sell: null });
    expect(board.coins.find((c) => c.code === 'usdt')).toMatchObject({ available: true, buy: { ngnPerUsd: '1520.00' } });
  });

  it('a paused coin still shows its price, marked not tradable', async () => {
    const { svc } = build({ paused: ['btc'] });
    const btc = (await svc.board()).coins.find((c) => c.code === 'btc')!;
    expect(btc).toMatchObject({ available: true, tradable: false });
  });

  it('is shared for 30 seconds: a second request does not ask Quidax again', async () => {
    const { svc, calls } = build();
    await svc.board();
    const first = { price: calls.price, sellPrice: calls.sellPrice };
    await svc.board();
    expect({ price: calls.price, sellPrice: calls.sellPrice }).toEqual(first);
  });

  it('never shows a negative sell price when the margin is wider than the price', async () => {
    const { svc } = build({ sellGate: '5000' });
    const usdt = (await svc.board()).coins.find((c) => c.code === 'usdt')!;
    expect(usdt.sell).toEqual({ ngnPerUsd: '0.00', ngnPerUnit: '0.00' });
  });
});
