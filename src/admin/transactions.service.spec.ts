import { Prisma, TxStatus, TxType } from '@prisma/client';
import { figuresFor, isAwaitingApproval } from './transactions.service';
import { isSerializationFailure } from '../prisma/prisma.service';

const d = (v: string) => new Prisma.Decimal(v);

/**
 * The parts of the transactions manager that have to be right without a
 * database in front of them: what the three money columns come to, what may be
 * decided by hand, and what a lost race looks like.
 */
describe('figuresFor', () => {
  const base = {
    fromAsset: null,
    toAsset: null,
    fromAmount: null,
    toAmount: null,
    feeAmount: null,
    feeUsd: null,
    usdValue: null,
    gateApplied: null,
  };

  it('prices a buy in the naira that left', () => {
    // ₦400,000 paid, of which the rate fee is $1,000 × ₦3.28137.
    const f = figuresFor({
      ...base,
      type: TxType.BUY,
      fromAsset: 'ngn',
      toAsset: 'btc',
      fromAmount: d('400000'),
      toAmount: d('0.5'),
      usdValue: d('1000'),
      gateApplied: d('3.28137'),
    });
    expect(f).toEqual({
      unit: 'NGN',
      total: '400000.00',
      fee: '3281.37',
      amount: '396718.63',
    });
  });

  it('prices a sell in the naira that arrived, grossing the fee back up', () => {
    // The seller is credited NET, so the gross is what they got plus our cut.
    const f = figuresFor({
      ...base,
      type: TxType.SELL,
      fromAsset: 'btc',
      toAsset: 'ngn',
      toAmount: d('396718.63'),
      usdValue: d('1000'),
      gateApplied: d('3.28137'),
    });
    expect(f).toEqual({
      unit: 'NGN',
      total: '400000.00',
      fee: '3281.37',
      amount: '396718.63',
    });
  });

  it('prices a swap in dollars, because two coins and a fee have no other unit', () => {
    const f = figuresFor({
      ...base,
      type: TxType.SWAP,
      fromAsset: 'btc',
      toAsset: 'usdt',
      fromAmount: d('0.01'),
      toAmount: d('980'),
      feeAmount: d('20'),
      usdValue: d('1000'),
      feeUsd: d('20'),
    });
    expect(f).toEqual({ unit: 'USD', total: '1000.00', fee: '20.00', amount: '980.00' });
  });

  it('prices a crypto withdrawal in the coin, at coin precision', () => {
    // fromAmount is the total debited: what was sent plus our fee.
    const f = figuresFor({
      ...base,
      type: TxType.WITHDRAWAL,
      fromAsset: 'btc',
      fromAmount: d('0.10250000'),
      feeAmount: d('0.00250000'),
    });
    expect(f).toEqual({
      unit: 'BTC',
      total: '0.10250000',
      fee: '0.00250000',
      amount: '0.10000000',
    });
  });

  it('prices a naira withdrawal in naira', () => {
    const f = figuresFor({
      ...base,
      type: TxType.WITHDRAWAL,
      fromAsset: 'ngn',
      fromAmount: d('50100'),
      toAmount: d('50000'),
      feeAmount: d('100'),
    });
    expect(f).toEqual({ unit: 'NGN', total: '50100.00', fee: '100.00', amount: '50000.00' });
  });

  it('charges nothing for money arriving', () => {
    const f = figuresFor({ ...base, type: TxType.DEPOSIT, toAsset: 'ngn', toAmount: d('35000') });
    expect(f).toEqual({ unit: 'NGN', total: '35000.00', fee: '0.00', amount: '35000.00' });
  });

  it('always states three figures that add up', () => {
    /*
     * The rate fee is a product of two 18-decimal columns, so it lands on a
     * half-kobo often. Rounding the fee and the amount independently would put
     * them on opposite sides of it and the row would read
     * ₦396,718.63 + ₦3,281.38 = ₦400,000.01 against a stated ₦400,000.00.
     */
    for (const gate of ['3.281375', '3.2813712', '0.0000051', '9.994999', '12.345']) {
      const f = figuresFor({
        ...base,
        type: TxType.BUY,
        fromAsset: 'ngn',
        fromAmount: d('400000'),
        usdValue: d('1000'),
        gateApplied: d(gate),
      });
      const sum = new Prisma.Decimal(f.amount).plus(f.fee).toFixed(2);
      expect(`gate ${gate}: ${f.amount} + ${f.fee} = ${sum}`).toBe(
        `gate ${gate}: ${f.amount} + ${f.fee} = ${f.total}`,
      );
    }
  });

  it('does not fall over on a trade that was never priced', () => {
    // usdValue and gateApplied are nullable; a buy that failed before pricing
    // has neither, and must still render as a row rather than a crash.
    const f = figuresFor({ ...base, type: TxType.BUY, fromAsset: 'ngn', fromAmount: d('1000') });
    expect(f).toEqual({ unit: 'NGN', total: '1000.00', fee: '0.00', amount: '1000.00' });
  });
});

describe('isAwaitingApproval', () => {
  const held = { type: TxType.DEPOSIT, status: TxStatus.ON_HOLD, toAsset: 'ngn' };

  it('is a held naira deposit, and only that', () => {
    expect(isAwaitingApproval(held)).toBe(true);
  });

  it('is not a held CRYPTO deposit — a coin arriving moves no real money', () => {
    expect(isAwaitingApproval({ ...held, toAsset: 'usdt' })).toBe(false);
  });

  it('is not a deposit that already went through', () => {
    expect(isAwaitingApproval({ ...held, status: TxStatus.COMPLETED })).toBe(false);
    expect(isAwaitingApproval({ ...held, status: TxStatus.FAILED })).toBe(false);
    expect(isAwaitingApproval({ ...held, status: TxStatus.PENDING })).toBe(false);
  });

  it('is never a RECONCILING transaction', () => {
    // The outcome there is genuinely unknown, and resolving one by hand is how
    // somebody gets paid twice. It must never reach the approval queue.
    expect(isAwaitingApproval({ ...held, status: TxStatus.RECONCILING })).toBe(false);
    expect(
      isAwaitingApproval({
        type: TxType.WITHDRAWAL,
        status: TxStatus.RECONCILING,
        toAsset: null,
      }),
    ).toBe(false);
  });

  it('is never a withdrawal, whatever state it is in', () => {
    for (const status of Object.values(TxStatus)) {
      expect(isAwaitingApproval({ type: TxType.WITHDRAWAL, status, toAsset: 'ngn' })).toBe(false);
    }
  });
});

describe('isSerializationFailure', () => {
  it('recognises Prisma’s own write-conflict code', () => {
    expect(isSerializationFailure({ code: 'P2034' })).toBe(true);
  });

  it('recognises the SQLSTATE carried on a failed raw query', () => {
    // How it actually arrives: the ledger takes its row lock through raw SQL,
    // so the conflict surfaces as a raw query failure with 40001 in the meta.
    expect(isSerializationFailure({ code: 'P2010', meta: { code: '40001' } })).toBe(true);
  });

  it('recognises the message, for anything that carries neither', () => {
    expect(
      isSerializationFailure({ message: 'could not serialize access due to concurrent update' }),
    ).toBe(true);
  });

  it('does not swallow an unrelated failure', () => {
    // These must keep their own status codes rather than becoming "already
    // dealt with", which would hide a real bug behind a plausible message.
    expect(isSerializationFailure({ code: 'P2025' })).toBe(false);
    expect(isSerializationFailure(new Error('connection refused'))).toBe(false);
    expect(isSerializationFailure(null)).toBe(false);
    expect(isSerializationFailure(undefined)).toBe(false);
  });
});
