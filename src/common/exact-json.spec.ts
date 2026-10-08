import { assertExactJsonSupported, parseJsonExact } from './exact-json';

/**
 * Flutterwave sends money as JSON numbers. A double cannot hold every decimal,
 * so every number must come back as the exact text it was written with.
 */
describe('parseJsonExact', () => {
  it('returns every number as its exact source text', () => {
    expect(parseJsonExact('{"amount":1500,"fee":26.875,"id":10535993}')).toEqual({
      amount: '1500',
      fee: '26.875',
      id: '10535993',
    });
  });

  it('keeps trailing zeros, signs and exponents exactly as written', () => {
    expect(parseJsonExact('[1.10, -0.50, 1e3, 0]')).toEqual(['1.10', '-0.50', '1e3', '0']);
  });

  it('keeps integers beyond 2^53 digit for digit', () => {
    expect(parseJsonExact('{"big":12345678901234567890}')).toEqual({ big: '12345678901234567890' });
  });

  it('converts numbers inside nested objects and arrays', () => {
    expect(parseJsonExact('{"data":[{"x":1},{"y":{"z":2.5}}]}')).toEqual({
      data: [{ x: '1' }, { y: { z: '2.5' } }],
    });
  });

  it('leaves strings, booleans and null alone', () => {
    expect(parseJsonExact('{"s":"123","t":true,"f":false,"n":null}')).toEqual({
      s: '123',
      t: true,
      f: false,
      n: null,
    });
  });

  it('still rejects malformed JSON', () => {
    expect(() => parseJsonExact('{"a":')).toThrow(SyntaxError);
  });
});

describe('assertExactJsonSupported', () => {
  it('passes on this runtime', () => {
    expect(() => assertExactJsonSupported()).not.toThrow();
  });
});
