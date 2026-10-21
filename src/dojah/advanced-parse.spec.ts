import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBill, parseIdAnalysis, parseLiveness, parseMatch, parseOcr } from './advanced-parse';

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'advanced', name), 'utf8'));

describe('parseIdAnalysis', () => {
  const body = (text_data: unknown[], status = { overall_status: 1, reason: 'VALID' }) => ({
    entity: { status, document_type: { document_name: 'Nigeria National ID Card' }, document_images: { portrait: 'AAAA' }, text_data },
  });
  it('maps the known field keys and keeps the portrait apart', () => {
    const r = parseIdAnalysis(
      body([
        { field_key: 'first_name', status: 1, value: 'SOMEONE' },
        { field_key: 'surname', status: 1, value: 'CLEAN' },
        { field_key: 'dob', status: 1, value: '03/03/1995' },
        { field_key: 'expiry_date', status: 1, value: '01/01/2030' },
        { field_key: 'document_number', status: 1, value: 'A12345678' },
      ]),
    );
    expect(r.read).toEqual({
      valid: true,
      documentName: 'Nigeria National ID Card',
      firstName: 'SOMEONE',
      middleName: null,
      lastName: 'CLEAN',
      dateOfBirth: '1995-03-03',
      expiry: '2030-01-01',
      documentNumber: 'A12345678',
      unreadable: [],
    });
    expect(r.portrait).toBe('AAAA');
  });
  it('splits a full name when only that is given (last word = surname)', () => {
    const r = parseIdAnalysis(body([{ field_key: 'full_name', status: 1, value: 'SOMEONE MIDDLE CLEAN' }]));
    expect(r.read).toMatchObject({ firstName: 'SOMEONE', middleName: 'MIDDLE', lastName: 'CLEAN' });
  });
  it('records unreadable fields (status 2) and ignores unknown keys', () => {
    const r = parseIdAnalysis(body([{ field_key: 'dob', status: 2, value: '' }, { field_key: 'mystery', status: 1, value: 'x' }]));
    expect(r.read.unreadable).toEqual(['dateOfBirth']);
    expect(r.read.dateOfBirth).toBeNull();
  });
  it('a name Dojah could not read is "unreadable", not just missing', () => {
    const r = parseIdAnalysis(body([{ field_key: 'surname', status: 2, value: '' }, { field_key: 'first_name', status: 1, value: 'SOMEONE' }]));
    expect(r.read.unreadable).toEqual(['name']);
    expect(r.read.lastName).toBeNull();
  });
  it('reads overall_status 0 as not valid', () => {
    expect(parseIdAnalysis(body([], { overall_status: 0, reason: 'NOT_VALID' })).read.valid).toBe(false);
  });
  it('survives a body with nothing in it', () => {
    expect(parseIdAnalysis({}).read).toMatchObject({ valid: false, firstName: null, unreadable: [] });
  });
});

describe('the other parsers', () => {
  it('liveness', () => {
    expect(parseLiveness({ entity: { liveness: { liveness_check: true, liveness_probability: 98.4 }, face: { face_detected: true, multiface_detected: false } } })).toEqual({
      live: true,
      probability: 98.4,
      faceDetected: true,
      multiFace: false,
    });
  });
  it('face match', () => {
    expect(parseMatch({ entity: { selfie: { confidence_value: 91.2, match: true } } })).toEqual({ confidence: 91.2 });
    expect(parseMatch({ entity: {} })).toEqual({ confidence: null });
  });
  it('utility bill', () => {
    expect(
      parseBill({
        entity: {
          result: { status: 'success' },
          identity_info: { full_name: 'JOHN DOE' },
          address_info: { street: '1 A St', city: 'Ikeja', state: 'Lagos' },
          provider_name: 'IE',
          bill_issue_date: '2026-10-01',
          metadata: { is_recent: true },
        },
      }),
    ).toEqual({ ok: true, fullName: 'JOHN DOE', street: '1 A St', city: 'Ikeja', state: 'Lagos', issueDate: '2026-10-01', isRecent: true, provider: 'IE' });
  });
  it('ocr keeps only strings', () => {
    expect(parseOcr({ entity: { data: ['A', 1, 'B'] } })).toEqual(['A', 'B']);
  });
});

describe("Dojah's documented examples (fixtures)", () => {
  it('document analysis', () => {
    const r = parseIdAnalysis(fixture('document-analysis.json'));
    expect(r.read).toMatchObject({ valid: false, documentName: 'Nigeria Passport', dateOfBirth: '1990-01-01' });
    expect(r.portrait).toBe('AAAA');
  });
  it('liveness', () => expect(parseLiveness(fixture('liveness.json'))).toMatchObject({ live: true, probability: 98, faceDetected: true }));
  it('photo ID verify', () => expect(parseMatch(fixture('photoid-verify.json'))).toEqual({ confidence: 98.79 }));
  it('utility bill', () => expect(parseBill(fixture('utility-bill.json'))).toMatchObject({ ok: true, fullName: 'JOHN DOE MUSA', isRecent: true, issueDate: '2025-01-15' }));
  it('ocr', () => expect(parseOcr(fixture('ocr.json'))).toEqual(['Surname:', 'DOE', '70142123456']));
});
