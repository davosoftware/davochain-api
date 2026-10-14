import { dec } from '../common/money';
import { formatQuoteRate } from './quote-rate';

describe('formatQuoteRate (FLUTTER_API Appendix F #17)', () => {
  it('a buy or sell rate is naira per dollar, 4 decimals as before', () => {
    expect(formatQuoteRate('BUY', dec('1485.123456'))).toBe('1485.1234');
    expect(formatQuoteRate('SELL', dec('1450'))).toBe('1450.0000');
  });

  it('a small swap rate keeps its significant digits instead of reading 0.0000', () => {
    expect(formatQuoteRate('SWAP', dec('0.0000142349876543'))).toBe('0.00001423498765');
  });

  it('a large swap rate is not padded or cut short', () => {
    expect(formatQuoteRate('SWAP', dec('70245.987654321'))).toBe('70245.98765');
  });

  it('a swap rate is rounded DOWN, never up, and never in exponent form', () => {
    const r = formatQuoteRate('SWAP', dec('0.000000019999999999999'));
    expect(r).toBe('0.00000001999999999');
    expect(r).not.toMatch(/e/i);
  });
});
