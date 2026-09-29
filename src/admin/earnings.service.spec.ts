import { Prisma } from '@prisma/client';
import { searchPattern, toRow, type RawRow } from './earnings.service';

/**
 * The two pieces of the earnings manager that have to be right on their own,
 * without a database in front of them: what a typed search means, and what the
 * three money columns come to.
 *
 * The classification itself — which ladder a transaction belongs to — is SQL
 * and is proved against a real database, not here.
 */
describe('searchPattern', () => {
  it('wraps an ordinary term in wildcards', () => {
    expect(searchPattern('Ada')).toBe('%Ada%');
    expect(searchPattern('fee-proof@example.com')).toBe('%fee-proof@example.com%');
  });

  it('makes a typed wildcard mean itself', () => {
    // Without this, one '%' in the box silently matches every earning ever —
    // a filter that appears to do nothing while quietly doing the opposite.
    expect(searchPattern('%')).toBe('%\\%%');
    expect(searchPattern('50%')).toBe('%50\\%%');
  });

  it('escapes the single-character wildcard, which people really do type', () => {
    // Every transaction reference contains an underscore (dvc_buy_…), so this
    // is a search somebody makes on their first day.
    expect(searchPattern('dvc_buy')).toBe('%dvc\\_buy%');
  });

  it('escapes the escape character first', () => {
    // Escaping the wildcards before the backslash would turn a typed '\' into
    // an escape of whatever followed it.
    expect(searchPattern('a\\b')).toBe('%a\\\\b%');
    expect(searchPattern('\\%')).toBe('%\\\\\\%%');
  });

  it('leaves a term that is only wildcards matching nothing real', () => {
    expect(searchPattern('%%%')).toBe('%\\%\\%\\%%');
  });
});

describe('toRow', () => {
  const raw = (over: Partial<RawRow> = {}): RawRow => ({
    id: 'tx-1',
    reference: 'dvc_buy_01',
    kind: 'RATE',
    type: 'BUY',
    currency: 'NGN',
    fee: new Prisma.Decimal('3281.37'),
    total: new Prisma.Decimal('400000'),
    fromAsset: 'ngn',
    toAsset: 'btc',
    userId: 'user-1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    createdAt: new Date('2026-09-05T20:47:40.353Z'),
    ...over,
  });

  it('makes the three money columns add up', () => {
    const row = toRow(raw());
    expect(row.total).toBe('400000.00');
    expect(row.fee).toBe('3281.37');
    expect(row.amount).toBe('396718.63');
    expect(Number(row.amount) + Number(row.fee)).toBeCloseTo(Number(row.total), 2);
  });

  it('holds for a dollar-charged swap as well as a naira trade', () => {
    const row = toRow(
      raw({
        kind: 'SWAP',
        type: 'SWAP',
        currency: 'USD',
        fee: new Prisma.Decimal('20'),
        total: new Prisma.Decimal('1000'),
        fromAsset: 'btc',
        toAsset: 'usdt',
      }),
    );
    expect([row.amount, row.fee, row.total]).toEqual(['980.00', '20.00', '1000.00']);
  });

  it('carries a figure far larger than a float would hold', () => {
    const row = toRow(
      raw({
        fee: new Prisma.Decimal('1234567.89'),
        total: new Prisma.Decimal('98765432109876.54'),
      }),
    );
    expect(row.total).toBe('98765432109876.54');
    expect(row.amount).toBe('98765430875308.65');
  });

  it('still adds up when the fee has more precision than money does', () => {
    /*
     * The case that matters: the rate fee is a product of two 18-decimal
     * columns, so it lands on a half-kobo often. Rounding the fee and the
     * amount independently would put them on opposite sides of it and the row
     * would read ₦396,718.63 + ₦3,281.38 = ₦400,000.01 against a stated total
     * of ₦400,000.00.
     */
    for (const fee of ['3281.375', '3281.3712', '0.005', '0.994999', '12.345', '0.0049']) {
      const row = toRow(raw({ fee: new Prisma.Decimal(fee), total: new Prisma.Decimal('400000') }));
      // Added as decimals, not floats, so the assertion cannot pass by the same
      // rounding it is meant to catch.
      const sum = new Prisma.Decimal(row.amount).plus(row.fee).toFixed(2);
      expect(`fee ${fee}: ${row.amount} + ${row.fee} = ${sum}`).toBe(
        `fee ${fee}: ${row.amount} + ${row.fee} = ${row.total}`,
      );
    }
  });

  it('reports a fee that rounds to nothing without claiming the row is free', () => {
    const row = toRow(raw({ fee: new Prisma.Decimal('0.001'), total: new Prisma.Decimal('10') }));
    // Shown as 0.00 at two places, but the row still exists — and the total it
    // contributes to is summed in the database at full precision, not from this.
    expect(row.fee).toBe('0.00');
    expect(row.amount).toBe('10.00');
  });

  it('joins the name without leaving a gap when half of it is missing', () => {
    expect(toRow(raw({ lastName: '' })).name).toBe('Ada');
    expect(toRow(raw({ firstName: '', lastName: '' })).name).toBe('');
  });

  it('hands the timestamp on in a form that survives JSON', () => {
    expect(toRow(raw()).createdAt).toBe('2026-09-05T20:47:40.353Z');
  });

  it('passes the assets through untouched, including a missing one', () => {
    const row = toRow(raw({ kind: 'NGN_WITHDRAWAL', fromAsset: 'ngn', toAsset: null }));
    expect(row.fromAsset).toBe('ngn');
    expect(row.toAsset).toBeNull();
  });
});
