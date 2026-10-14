import { AML_STATUS_TRANSITIONS, CASE_TRANSITIONS, SCREENING_TRANSITIONS, VERIFICATION_TRANSITIONS, allowed } from './aml-transitions';

const ALLOWED_VERIFICATION = [
  'CREATED>LOOKED_UP', 'CREATED>REJECTED_NOT_FOUND', 'CREATED>FAILED_SYSTEM',
  'LOOKED_UP>APPROVED', 'LOOKED_UP>IDENTITY_REVIEW', 'LOOKED_UP>COMPLIANCE_REVIEW',
  'IDENTITY_REVIEW>APPROVED', 'IDENTITY_REVIEW>COMPLIANCE_REVIEW', 'IDENTITY_REVIEW>REJECTED_BY_REVIEW',
  'COMPLIANCE_REVIEW>APPROVED',
];
const ALLOWED_SCREENING = ['PENDING>CLEAR', 'PENDING>POSSIBLE_MATCH', 'PENDING>CONFIRMED_MATCH', 'PENDING>UNKNOWN', 'PENDING>ERROR', 'ERROR>PENDING'];
const ALLOWED_CASE = [
  'OPEN>CLEARED', 'OPEN>PEP_APPROVED_EDD', 'OPEN>RESTRICTED', 'OPEN>SANCTIONS_CONFIRMED', 'OPEN>CLEARANCE_PROPOSED',
  'CLEARANCE_PROPOSED>SANCTIONS_FALSE_POSITIVE', 'CLEARANCE_PROPOSED>OPEN', 'RESTRICTED>CLEARED',
];
const ALLOWED_AML = [
  'NOT_SCREENED>PENDING', 'CLEAR>PENDING', 'PENDING>CLEAR', 'PENDING>UNDER_REVIEW', 'PENDING>BLOCKED',
  'UNDER_REVIEW>CLEAR', 'UNDER_REVIEW>RESTRICTED', 'UNDER_REVIEW>BLOCKED', 'RESTRICTED>CLEAR', 'BLOCKED>CLEAR',
];

function every(table: Record<string, readonly string[]>): string[] {
  const states = Object.keys(table);
  return states.flatMap((a) => states.map((b) => `${a}>${b}`));
}

describe.each([
  ['verification', VERIFICATION_TRANSITIONS, ALLOWED_VERIFICATION],
  ['screening', SCREENING_TRANSITIONS, ALLOWED_SCREENING],
  ['case', CASE_TRANSITIONS, ALLOWED_CASE],
  ['amlStatus', AML_STATUS_TRANSITIONS, ALLOWED_AML],
])('%s transitions', (_name, table, allowedPairs) => {
  it.each(every(table as Record<string, readonly string[]>))('%s', (pair) => {
    const [from, to] = pair.split('>');
    expect(allowed(table as Record<string, readonly string[]>, from, to)).toBe(allowedPairs.includes(pair));
  });
});

it('terminal verification states lead nowhere', () => {
  for (const s of ['APPROVED', 'REJECTED_NOT_FOUND', 'REJECTED_BY_REVIEW', 'FAILED_SYSTEM'] as const) {
    expect(VERIFICATION_TRANSITIONS[s]).toEqual([]);
  }
});

it('BLOCKED is left only for CLEAR (the two-person confirmation), never PENDING', () => {
  expect(AML_STATUS_TRANSITIONS.BLOCKED).toEqual(['CLEAR']);
});
