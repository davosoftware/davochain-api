import { CURRENCIES, currency, formatAmount, isKnownCurrency, symbolFor } from './currencies';

describe('the currency list', () => {
  it('has no duplicate codes', () => {
    const codes = CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('is all valid ISO 4217 shapes', () => {
    for (const c of CURRENCIES) {
      expect(c.code).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('gives every currency a symbol and a name', () => {
    for (const c of CURRENCIES) {
      expect(c.symbol.length).toBeGreaterThan(0);
      expect(c.name.length).toBeGreaterThan(2);
    }
  });

  it('leads with the ones a Nigerian desk sees most', () => {
    // A dropdown sorted alphabetically buries USD under AED.
    expect(CURRENCIES.slice(0, 3).map((c) => c.code)).toEqual(['USD', 'GBP', 'EUR']);
  });

  it('covers the cards this market actually trades', () => {
    const codes = new Set(CURRENCIES.map((c) => c.code));
    for (const expected of ['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'AED', 'CHF', 'JPY']) {
      expect(codes.has(expected)).toBe(true);
    }
  });
});

describe('isKnownCurrency', () => {
  it('accepts one from the list, however it is typed', () => {
    expect(isKnownCurrency('USD')).toBe(true);
    expect(isKnownCurrency('usd')).toBe(true);
    expect(isKnownCurrency('  gbp  ')).toBe(true);
  });

  it('refuses a code we have no symbol for', () => {
    // The whole point: a three-letter code that passes a regex but renders as
    // nothing beside an amount field.
    expect(isKnownCurrency('XYZ')).toBe(false);
    expect(isKnownCurrency('ABC')).toBe(false);
    expect(isKnownCurrency('')).toBe(false);
  });
});

describe('symbolFor', () => {
  it('gives the symbol', () => {
    expect(symbolFor('USD')).toBe('$');
    expect(symbolFor('GBP')).toBe('£');
    expect(symbolFor('JPY')).toBe('¥');
    expect(symbolFor('INR')).toBe('₹');
  });

  it('distinguishes the dollars', () => {
    // "$500" on a Canadian card that is really C$500 misprices it by a fifth.
    const dollars = ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD'].map(symbolFor);
    expect(new Set(dollars).size).toBe(dollars.length);
  });

  it('falls back to the code rather than nothing', () => {
    // A row written before a currency was retired still has to render.
    expect(symbolFor('XAF')).toBe('XAF');
  });
});

describe('formatAmount', () => {
  it('puts the symbol in front, for most', () => {
    expect(formatAmount('USD', '100')).toBe('$100');
    expect(formatAmount('CAD', '100')).toBe('C$100');
  });

  it('puts it behind, where that is the convention', () => {
    // "kr 500" and "zł 500" read wrong to the people who use them.
    expect(formatAmount('SEK', '500')).toBe('500 kr');
    expect(formatAmount('NOK', '500')).toBe('500 kr');
    expect(formatAmount('PLN', '500')).toBe('500 zł');
  });

  it('still renders something for an unknown code', () => {
    expect(formatAmount('XAF', '500')).toBe('XAF500');
  });
});

describe('currency', () => {
  it('returns the whole record, or null', () => {
    expect(currency('gbp')).toEqual({
      code: 'GBP',
      symbol: '£',
      name: 'British pound',
      symbolFirst: true,
    });
    expect(currency('XYZ')).toBeNull();
  });
});
