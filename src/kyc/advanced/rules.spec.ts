import { decideAddress, decideIdentity, summariseBill, summariseText } from './rules';
import type { IdRead, Verified } from './advanced.types';

const today = '2026-10-21';
const t = { livenessMin: 90, faceMatchPass: 75, faceMatchReview: 60 };
const verified: Verified = {
  firstName: 'Someone',
  middleName: null,
  lastName: 'Clean',
  dateOfBirth: '1995-03-03',
  address: { street: '1 E2E Street', city: 'Ikeja', state: 'Lagos' },
};
const read = (over: Partial<IdRead> = {}): IdRead => ({
  valid: true,
  documentName: 'Nigeria National ID Card',
  firstName: 'SOMEONE',
  middleName: null,
  lastName: 'CLEAN',
  dateOfBirth: '1995-03-03',
  expiry: '2030-01-01',
  documentNumber: 'A12345678',
  unreadable: [],
  ...over,
});
const live = { live: true, probability: 98, faceDetected: true, multiFace: false };
const all = (over: Partial<Parameters<typeof decideIdentity>[0]> = {}) =>
  decideIdentity({ idType: 'NATIONAL_ID', read: read(), liveness: live, match: { confidence: 92 }, verified, t, today, ...over });

describe('decideIdentity (spec §7.1)', () => {
  it('approves a clear pass', () => expect(all()).toEqual({ outcome: 'APPROVE', reasons: [] }));

  it('rejects an invalid document', () => expect(all({ read: read({ valid: false }) })).toMatchObject({ outcome: 'REJECT', code: 'ID_UNREADABLE' }));
  it('rejects missing names, but reviews names marked unreadable', () => {
    expect(all({ read: read({ firstName: null, lastName: null }) })).toMatchObject({ outcome: 'REJECT', code: 'ID_UNREADABLE' });
    expect(all({ read: read({ firstName: null, lastName: null, unreadable: ['name'] }) })).toEqual({ outcome: 'REVIEW', reasons: ['ID_FIELD_UNREADABLE'] });
  });
  it('rejects a missing date of birth, but reviews one marked unreadable', () => {
    expect(all({ read: read({ dateOfBirth: null }) })).toMatchObject({ outcome: 'REJECT', code: 'ID_UNREADABLE' });
    expect(all({ read: read({ dateOfBirth: null, unreadable: ['dateOfBirth'] }) })).toEqual({ outcome: 'REVIEW', reasons: ['DOB_UNREADABLE'] });
  });
  it('rejects a different date of birth', () => expect(all({ read: read({ dateOfBirth: '1990-01-01' }) })).toMatchObject({ outcome: 'REJECT', code: 'DETAILS_MISMATCH' }));
  it('sends a different name to a person, never rejects it', () => expect(all({ read: read({ firstName: 'Somebody' }) })).toEqual({ outcome: 'REVIEW', reasons: ['NAME_DIFFERS'] }));
  it('accepts first and last swapped (Basic rules)', () => expect(all({ read: read({ firstName: 'CLEAN', lastName: 'SOMEONE' }) }).outcome).toBe('APPROVE'));

  it('rejects an ID that expired before today; expiring today is fine', () => {
    expect(all({ read: read({ expiry: '2026-10-20' }) })).toMatchObject({ outcome: 'REJECT', code: 'ID_EXPIRED' });
    expect(all({ read: read({ expiry: '2026-10-21' }) }).outcome).toBe('APPROVE');
  });
  it('reviews an ID with no expiry', () => expect(all({ read: read({ expiry: null }) })).toEqual({ outcome: 'REVIEW', reasons: ['NO_EXPIRY'] }));
  it('reviews a document whose name says a different type', () =>
    expect(all({ read: read({ documentName: 'International Passport' }) })).toEqual({ outcome: 'REVIEW', reasons: ['ID_TYPE_DIFFERS'] }));

  it('rejects a selfie that is not live, has no face, or has two', () => {
    for (const l of [{ ...live, live: false }, { ...live, faceDetected: false }, { ...live, multiFace: true }]) {
      expect(all({ liveness: l })).toMatchObject({ outcome: 'REJECT', code: 'SELFIE_NOT_LIVE' });
    }
  });
  it('reviews a live selfie under the liveness mark; exactly the mark passes', () => {
    expect(all({ liveness: { ...live, probability: 89 } })).toEqual({ outcome: 'REVIEW', reasons: ['LIVENESS_LOW'] });
    expect(all({ liveness: { ...live, probability: 90 } }).outcome).toBe('APPROVE');
  });
  it('face match: 75 passes, 74 and 60 review, 59 rejects', () => {
    expect(all({ match: { confidence: 75 } }).outcome).toBe('APPROVE');
    expect(all({ match: { confidence: 74 } })).toEqual({ outcome: 'REVIEW', reasons: ['FACE_MATCH_BORDERLINE'] });
    expect(all({ match: { confidence: 60 } })).toEqual({ outcome: 'REVIEW', reasons: ['FACE_MATCH_BORDERLINE'] });
    expect(all({ match: { confidence: 59 } })).toMatchObject({ outcome: 'REJECT', code: 'FACE_MISMATCH' });
  });
  it('reviews when the ID has no photo to compare', () => expect(all({ match: undefined, noPortrait: true })).toEqual({ outcome: 'REVIEW', reasons: ['NO_ID_PHOTO'] }));
  it('reviews a duplicate ID, never rejects it', () => expect(all({ duplicate: true })).toEqual({ outcome: 'REVIEW', reasons: ['DUPLICATE_ID'] }));
  it('a reject wins over review reasons, and keeps them', () => {
    expect(all({ read: read({ firstName: 'Somebody', expiry: '2020-01-01' }) })).toEqual({ outcome: 'REJECT', code: 'ID_EXPIRED', reasons: ['NAME_DIFFERS'] });
  });
  it('after the read alone (no liveness or match yet) approves nothing', () => {
    expect(decideIdentity({ idType: 'NATIONAL_ID', read: read(), verified, t, today }).outcome).toBe('REVIEW');
  });
});

describe('address evidence and decision (spec §7.2)', () => {
  const lines = ['ACCOUNT STATEMENT', 'SOMEONE CLEAN', '1 E2E STREET, IKEJA, LAGOS', 'Statement date: 11/10/2026'];
  it('approves a recent statement with the name and address', () => {
    const evidence = summariseText(lines, 'BANK_STATEMENT', verified, today);
    expect(evidence).toMatchObject({ source: 'TEXT', name: 'FULL', date: '2026-10-11', address: 'MATCH' });
    expect(decideAddress({ kind: 'BANK_STATEMENT', pdf: false, evidence, recencyMonths: 3, today })).toEqual({ outcome: 'APPROVE', reasons: [] });
  });
  it('rejects an old one with the recency code', () => {
    const evidence = summariseText(['SOMEONE CLEAN', 'IKEJA LAGOS', '01/01/2025', 'x'.repeat(40)], 'GOVERNMENT_LETTER', verified, today);
    expect(decideAddress({ kind: 'GOVERNMENT_LETTER', pdf: false, evidence, recencyMonths: 3, today })).toMatchObject({ outcome: 'REJECT', code: 'DOC_TOO_OLD' });
  });
  it('reviews: no date, name not found, address partial', () => {
    const evidence = summariseText(['MR OTHER PERSON', 'Lekki, Lagos', 'x'.repeat(40)], 'BANK_STATEMENT', verified, today);
    expect(decideAddress({ kind: 'BANK_STATEMENT', pdf: false, evidence, recencyMonths: 3, today })).toEqual({
      outcome: 'REVIEW',
      reasons: ['NAME_NOT_FOUND', 'NO_DATE', 'ADDRESS_PARTIAL'],
    });
  });
  it('tenancy: a running agreement passes, an ended one is too old, no end date is reviewed', () => {
    const running = summariseText(['TENANCY AGREEMENT', 'Tenant: Someone Clean', '1 E2E Street Ikeja Lagos', 'from 01/01/2025 to 31/12/2027'], 'TENANCY', verified, today);
    expect(decideAddress({ kind: 'TENANCY', pdf: false, evidence: running, recencyMonths: 3, today }).outcome).toBe('APPROVE');
    const ended = summariseText(['TENANCY AGREEMENT', 'Tenant: Someone Clean', '1 E2E Street Ikeja Lagos', 'from 01/01/2024 to 31/12/2025'], 'TENANCY', verified, today);
    expect(decideAddress({ kind: 'TENANCY', pdf: false, evidence: ended, recencyMonths: 3, today })).toMatchObject({ outcome: 'REJECT', code: 'DOC_TOO_OLD' });
    const undated = summariseText(['TENANCY AGREEMENT', 'Tenant: Someone Clean', '1 E2E Street Ikeja Lagos', 'x'.repeat(20)], 'TENANCY', verified, today);
    expect(decideAddress({ kind: 'TENANCY', pdf: false, evidence: undated, recencyMonths: 3, today })).toEqual({ outcome: 'REVIEW', reasons: ['NO_END_DATE'] });
  });
  it('very little text goes to a person', () => {
    const evidence = summariseText(['SOMEONE'], 'BANK_STATEMENT', verified, today);
    expect(decideAddress({ kind: 'BANK_STATEMENT', pdf: false, evidence, recencyMonths: 3, today }).reasons).toContain('TEXT_SPARSE');
  });
  it('a PDF goes to a person without evidence', () => {
    expect(decideAddress({ kind: 'BANK_STATEMENT', pdf: true, recencyMonths: 3, today })).toEqual({ outcome: 'REVIEW', reasons: ['PDF'] });
  });
  it("a utility bill uses Dojah's structured fields", () => {
    const evidence = summariseBill(
      { ok: true, fullName: 'SOMEONE CLEAN', street: '1 E2E Street', city: 'Ikeja', state: 'Lagos', issueDate: '2026-10-01', isRecent: true, provider: 'Ikeja Electric' },
      verified,
    );
    expect(evidence).toMatchObject({ source: 'BILL', name: 'FULL', date: '2026-10-01', address: 'MATCH', provider: 'Ikeja Electric' });
    expect(decideAddress({ kind: 'UTILITY_BILL', pdf: false, evidence, recencyMonths: 3, today }).outcome).toBe('APPROVE');
  });
  it('a bill Dojah answered but could not read goes to a person (only a 424 rejects; final review M1)', () => {
    const evidence = summariseBill({ ok: false, fullName: null, street: null, city: null, state: null, issueDate: null, isRecent: null, provider: null }, verified);
    expect(decideAddress({ kind: 'UTILITY_BILL', pdf: false, evidence, recencyMonths: 3, today })).toEqual({ outcome: 'REVIEW', reasons: ['TEXT_SPARSE'] });
  });
});
