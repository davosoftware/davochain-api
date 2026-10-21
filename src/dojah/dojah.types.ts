export type DojahOp = 'lookup' | 'aml' | 'balance' | 'readId' | 'liveness' | 'faceMatch' | 'utilityBill' | 'ocr';

export interface NormalisedIdentity {
  usable: boolean;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  dateOfBirth: string | null;
  gender: 'MALE' | 'FEMALE' | 'UNKNOWN';
  customerRef: string | null;
}

export type AmlCategory = 'SANCTIONS' | 'PEP' | 'ADVERSE_MEDIA' | 'WARNING' | 'UNKNOWN';

export interface AmlMatch {
  name: string | null;
  aliases: string[];
  dateOfBirth: string | null;
  country: string | null;
  positions: string[];
  sourceType: string | null;
  score: number | null;
  articles: { title: string; url: string }[];
}

export interface AmlParsed {
  status: 'CLEAR' | 'POSSIBLE_MATCH' | 'CONFIRMED_MATCH' | 'UNKNOWN';
  matchStatus: string | null;
  riskLevel: string | null;
  entityId: string | null;
  category: AmlCategory | null;
  matches: AmlMatch[];
}

/** What the rest of the code sees from a lookup. */
export type LookupResult = { found: true; identity: NormalisedIdentity; httpStatus: number } | { found: false; httpStatus: 404 };

/** What the rest of the code sees from a screen. */
export interface AmlResult {
  parsed: AmlParsed;
  httpStatus: number;
}
