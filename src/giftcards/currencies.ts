/**
 * The currencies gift cards actually come in.
 *
 * Held here rather than in the dashboard because three places need to agree:
 * the admin picking one, the API storing it, and the app drawing the amount
 * field. A list that lived only in the browser would let an admin choose a
 * currency the app has no symbol for, and the seller would see a bare number.
 *
 * Ordered by how often a Nigerian desk actually sees them, because a dropdown
 * sorted alphabetically buries USD under AED.
 */
export interface Currency {
  /** ISO 4217. What is stored, and what a rate is "naira per one of". */
  code: string;
  symbol: string;
  name: string;
  /**
   * Whether the symbol goes before the number.
   *
   * True for most, false for the Nordic krona and the Polish złoty — "500 kr"
   * is right and "kr 500" is not. One boolean, and it is the difference
   * between correct and nearly correct.
   */
  symbolFirst: boolean;
}

export const CURRENCIES: Currency[] = [
  { code: 'USD', symbol: '$', name: 'US dollar', symbolFirst: true },
  { code: 'GBP', symbol: '£', name: 'British pound', symbolFirst: true },
  { code: 'EUR', symbol: '€', name: 'Euro', symbolFirst: true },
  { code: 'CAD', symbol: 'C$', name: 'Canadian dollar', symbolFirst: true },
  { code: 'AUD', symbol: 'A$', name: 'Australian dollar', symbolFirst: true },
  { code: 'NZD', symbol: 'NZ$', name: 'New Zealand dollar', symbolFirst: true },
  { code: 'CHF', symbol: 'CHF', name: 'Swiss franc', symbolFirst: true },
  { code: 'AED', symbol: 'AED', name: 'UAE dirham', symbolFirst: true },
  { code: 'SAR', symbol: 'SAR', name: 'Saudi riyal', symbolFirst: true },
  { code: 'SGD', symbol: 'S$', name: 'Singapore dollar', symbolFirst: true },
  { code: 'HKD', symbol: 'HK$', name: 'Hong Kong dollar', symbolFirst: true },
  { code: 'JPY', symbol: '¥', name: 'Japanese yen', symbolFirst: true },
  { code: 'CNY', symbol: 'CN¥', name: 'Chinese yuan', symbolFirst: true },
  { code: 'INR', symbol: '₹', name: 'Indian rupee', symbolFirst: true },
  { code: 'TRY', symbol: '₺', name: 'Turkish lira', symbolFirst: true },
  { code: 'BRL', symbol: 'R$', name: 'Brazilian real', symbolFirst: true },
  { code: 'MXN', symbol: 'Mex$', name: 'Mexican peso', symbolFirst: true },
  { code: 'ZAR', symbol: 'R', name: 'South African rand', symbolFirst: true },
  { code: 'GHS', symbol: 'GH₵', name: 'Ghanaian cedi', symbolFirst: true },
  { code: 'KES', symbol: 'KSh', name: 'Kenyan shilling', symbolFirst: true },
  { code: 'PLN', symbol: 'zł', name: 'Polish złoty', symbolFirst: false },
  { code: 'SEK', symbol: 'kr', name: 'Swedish krona', symbolFirst: false },
  { code: 'NOK', symbol: 'kr', name: 'Norwegian krone', symbolFirst: false },
  { code: 'DKK', symbol: 'kr', name: 'Danish krone', symbolFirst: false },
];

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));

export function isKnownCurrency(code: string): boolean {
  return BY_CODE.has(code.trim().toUpperCase());
}

/**
 * What to draw beside an amount.
 *
 * Falls back to the code itself for anything unrecognised — a row written
 * before a currency was retired from the list still has to render as
 * something, and "500 XAF" beats "500".
 */
export function symbolFor(code: string): string {
  return BY_CODE.get(code.trim().toUpperCase())?.symbol ?? code.trim().toUpperCase();
}

export function currency(code: string): Currency | null {
  return BY_CODE.get(code.trim().toUpperCase()) ?? null;
}

/** An amount with its symbol on the correct side. */
export function formatAmount(code: string, amount: string): string {
  const c = currency(code);
  const symbol = c?.symbol ?? code.trim().toUpperCase();
  return c?.symbolFirst === false ? `${amount} ${symbol}` : `${symbol}${amount}`;
}
