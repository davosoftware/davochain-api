import type { NormalisedIdentity } from '../dojah/dojah.types';

export type FieldResult = 'MATCH' | 'MISMATCH';
export interface NameMatch {
  matched: boolean;
  swapped: boolean;
  fields: { firstName: FieldResult; lastName: FieldResult; middleName: FieldResult | 'SKIPPED'; dateOfBirth: FieldResult };
}

/** Spec §5: NFKD, strip diacritics, lower-case, keep only a–z. */
export function cleanName(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]/g, '');
}

const same = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = cleanName(a ?? '');
  return x.length > 0 && x === cleanName(b ?? '');
};

/** Exact after cleanup. First and last may be swapped; middle only when both sides have one. */
export function matchIdentity(
  typed: { firstName: string; middleName?: string | null; lastName: string; dateOfBirth: string },
  record: NormalisedIdentity,
): NameMatch {
  const straight = same(typed.firstName, record.firstName) && same(typed.lastName, record.lastName);
  const swapped = !straight && same(typed.firstName, record.lastName) && same(typed.lastName, record.firstName);

  const firstName: FieldResult = straight || swapped || same(typed.firstName, record.firstName) ? 'MATCH' : 'MISMATCH';
  const lastName: FieldResult = straight || swapped || same(typed.lastName, record.lastName) ? 'MATCH' : 'MISMATCH';
  const bothMiddle = cleanName(typed.middleName ?? '') !== '' && cleanName(record.middleName ?? '') !== '';
  const middleName = bothMiddle ? (same(typed.middleName, record.middleName) ? 'MATCH' : 'MISMATCH') : 'SKIPPED';
  const dateOfBirth: FieldResult = record.dateOfBirth !== null && typed.dateOfBirth === record.dateOfBirth ? 'MATCH' : 'MISMATCH';

  const matched = record.usable && (straight || swapped) && middleName !== 'MISMATCH' && dateOfBirth === 'MATCH';
  return { matched, swapped, fields: { firstName, lastName, middleName, dateOfBirth } };
}
