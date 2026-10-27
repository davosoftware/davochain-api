import { BadRequestException, ConflictException } from '@nestjs/common';
import { QuoteSide } from '@prisma/client';
import { QuotesService } from './quotes.service';
import { dec } from '../common/money';

/**
 * Swap pricing (27 Oct 2026, decision): the customer's price is Quidax's LIVE
 * swap quotation with our swap fee (Fees → Swap fee, flat dollars) on top, and
 * the swap confirms that same quotation, so what the customer is shown is what
 * Quidax delivers. When the quotation has expired at the tap, a fresh one is
 * used if it's no more than 0.5% worse; otherwise the customer is asked.
 */
const SECOND = 1000;

function build(o: { quotation?: { to_amount: string; expiresInMs?: number }; stored?: Record<string, unknown>; tolerance?: number } = {}) {
  let row: Record<string, unknown> | null = o.stored ?? null;
  let n = 0;
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ kycTier: 'TIER_1' })) },
    rateQuote: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: `q${++n}`, createdAt: new Date(), ...data })),
      findUnique: jest.fn(async () => row),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => (row = { ...row!, ...data })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const rates = {
    rateConfig: jest.fn(async () => ({ id: 'cfg1', maxTradeUsd: '100000', swapFeeUsd: '1' })),
    // Our cached prices: deliberately NOT what Quidax quotes, so a test can tell which one priced the swap.
    price: jest.fn(async (code: string) => ({ priceUsd: code === 'btc' ? dec('60000') : dec('1') })),
  };
  const assets = { require: jest.fn(async (code: string) => ({ code, transferStep: '0.000001', displayScale: 6 })) };
  const config = { get: (k: string) => ({ QUOTE_TTL_SECONDS: 12, QUOTE_HARD_EXPIRY_SECONDS: 30, SWAP_REQUOTE_TOLERANCE_BPS: o.tolerance ?? 50 })[k] };
  let quotations = 0;
  const settlement = {
    quidaxIdFor: jest.fn(async () => 'sub-1'),
    swapQuotation: jest.fn(async () => ({
      id: `qx${++quotations}`,
      to_amount: o.quotation?.to_amount ?? '59000',
      expires_at: new Date(Date.now() + (o.quotation?.expiresInMs ?? 15 * SECOND)).toISOString(),
    })),
  };
  const svc = new QuotesService(
    prisma as never,
    rates as never,
    { resolve: jest.fn(async () => null) } as never, // no swap ladder: the flat $1 fee
    assets as never,
    { getBalance: jest.fn(async () => ({ available: dec('10') })) } as never,
    { assertTradingAllowed: jest.fn(async () => undefined) } as never,
    config as never,
    { fx: async () => ({ ngnPerUsd: dec('1500') }), assertWithinLimits: async () => undefined } as never,
    settlement as never,
  );
  return { svc, prisma, settlement, current: () => row };
}

/** A swap quote as stored: 1 BTC → 58,999 USDT net, fee 1 USDT, Quidax quotation qx-old. */
function stored(over: Record<string, unknown> = {}) {
  return {
    id: 'q-old',
    userId: 'u1',
    side: QuoteSide.SWAP,
    fromAsset: 'btc',
    toAsset: 'usdt',
    fromAmount: dec('1'),
    toAmount: dec('58999'),
    feeAmount: dec('1'),
    feeAsset: 'usdt',
    quidaxQuotationId: 'qx-old',
    quidaxQuotationExpiresAt: new Date(Date.now() - SECOND), // expired at Quidax
    expiresAt: new Date(Date.now() - SECOND),
    createdAt: new Date(Date.now() - 16 * SECOND),
    consumedAt: null,
    ...over,
  };
}

describe('Swap quote: Quidax live price + our fee on top', () => {
  it("prices from Quidax's own swap quotation, not our cached prices, and keeps the quotation", async () => {
    const t = build({ quotation: { to_amount: '59000' } }); // our cached prices would say 60,000
    const view = await t.svc.quoteSwap('u1', 'btc', 'usdt', dec('1'));
    expect(t.settlement.swapQuotation).toHaveBeenCalledWith('sub-1', 'btc', 'usdt', dec('1'));
    expect(view.toAmount).toBe('58999.00000000'); // 59,000 from Quidax − our $1 fee
    const data = (t.prisma.rateQuote.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ quidaxQuotationId: 'qx1', toAmount: '58999', feeAmount: '1' });
    expect(data.quidaxQuotationExpiresAt).toBeInstanceOf(Date);
  });

  it("the quote never outlives Quidax's quotation", async () => {
    const t = build({ quotation: { to_amount: '59000', expiresInMs: 8 * SECOND } });
    const view = await t.svc.quoteSwap('u1', 'btc', 'usdt', dec('1'));
    expect(new Date(view.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 8 * SECOND);
  });
});

describe('Tapping Swap: the price is picked up again if it expired', () => {
  it("Quidax's quotation still fresh: the quote is used as it is", async () => {
    const t = build({ stored: stored({ quidaxQuotationExpiresAt: new Date(Date.now() + 10 * SECOND), expiresAt: new Date(Date.now() + 5 * SECOND), createdAt: new Date() }) });
    const q = await t.svc.consume('u1', 'q-old');
    expect(t.settlement.swapQuotation).not.toHaveBeenCalled();
    expect(q).toMatchObject({ quidaxQuotationId: 'qx-old' });
    expect(dec(q.toAmount as never).toFixed()).toBe('58999');
  });

  it('expired, new price within 0.5%: goes through at the new price (a fresh quotation, the new amount)', async () => {
    const t = build({ stored: stored(), quotation: { to_amount: '58800' } }); // 58,799 net: 0.34% worse
    const q = await t.svc.consume('u1', 'q-old');
    expect(q).toMatchObject({ quidaxQuotationId: 'qx1' });
    expect(dec(q.toAmount as never).toFixed()).toBe('58799');
    expect(t.prisma.rateQuote.updateMany).toHaveBeenCalled(); // and it is consumed
  });

  it('expired, new price better: goes through at the better price', async () => {
    const t = build({ stored: stored(), quotation: { to_amount: '59500' } });
    const q = await t.svc.consume('u1', 'q-old');
    expect(dec(q.toAmount as never).toFixed()).toBe('59499');
  });

  it('expired, new price more than 0.5% worse: nothing happens, and the customer gets the new price to accept', async () => {
    const t = build({ stored: stored(), quotation: { to_amount: '58000' } }); // 57,999 net: 1.7% worse
    const err = await t.svc.consume('u1', 'q-old').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const body = err.getResponse();
    expect(body).toMatchObject({ code: 'PRICE_CHANGED', quote: { toAmount: '57999.00000000', fromAmount: '1.00000000' } });
    expect(body.message).toMatch(/price changed/i);
    expect(t.prisma.rateQuote.updateMany).not.toHaveBeenCalled(); // the old quote isn't used up
  });

  it('the threshold comes from Server settings (SWAP_REQUOTE_TOLERANCE_BPS)', async () => {
    const t = build({ stored: stored(), quotation: { to_amount: '58000' }, tolerance: 200 }); // 2% allowed
    const q = await t.svc.consume('u1', 'q-old');
    expect(dec(q.toAmount as never).toFixed()).toBe('57999');
  });

  it('older than the hard expiry (30 s): refused as before, the app asks for a new quote', async () => {
    const t = build({ stored: stored({ createdAt: new Date(Date.now() - 31 * SECOND) }) });
    await expect(t.svc.consume('u1', 'q-old')).rejects.toThrow(BadRequestException);
    expect(t.settlement.swapQuotation).not.toHaveBeenCalled();
  });
});
