import bvn from './__fixtures__/bvn-full.json';
import nin from './__fixtures__/nin.json';
import amlSandbox from './__fixtures__/aml-sandbox.json';
import amlNoMatch from './__fixtures__/aml-no-match.json';
import amlConfirmed from './__fixtures__/aml-sanctions-confirmed.json';
import amlPossible from './__fixtures__/aml-sanctions-possible.json';
import { normaliseIdentity, parseAmlResult } from './normalise';

describe('normaliseIdentity (principle 1)', () => {
  it('normalises the real BVN record', () => {
    expect(normaliseIdentity(bvn)).toEqual({
      usable: true, firstName: 'JOHN', middleName: 'DOE', lastName: 'AJAYI',
      dateOfBirth: '2000-05-01', gender: 'MALE', customerRef: '6b5e7f2a-test',
    });
  });

  it('normalises the real NIN record, gender "M"', () => {
    expect(normaliseIdentity(nin)).toMatchObject({ usable: true, gender: 'MALE', dateOfBirth: '1990-01-01' });
  });

  it.each([['Male', 'MALE'], ['M', 'MALE'], ['male', 'MALE'], ['F', 'FEMALE'], ['Female', 'FEMALE'], ['f', 'FEMALE'], ['', 'UNKNOWN'], ['X', 'UNKNOWN'], [undefined, 'UNKNOWN']])(
    'gender %p → %s',
    (g, want) => expect(normaliseIdentity({ entity: { ...bvn.entity, gender: g } }).gender).toBe(want),
  );

  it('trims and collapses spaces in names, keeping their case', () => {
    expect(normaliseIdentity({ entity: { ...bvn.entity, first_name: '  Mary   Ann ' } }).firstName).toBe('Mary Ann');
  });

  it.each(['01/05/2000', '2000-5-1', '', null, '2000-02-30'])('date %p makes the record unusable', (d) => {
    expect(normaliseIdentity({ entity: { ...bvn.entity, date_of_birth: d } })).toMatchObject({ usable: false, dateOfBirth: null });
  });

  it('a record with no first or last name is unusable', () => {
    expect(normaliseIdentity({ entity: { ...bvn.entity, last_name: '  ' } }).usable).toBe(false);
  });

  it.each([[undefined], [null], [{}], [{ entity: null }], [{ entity: [] }], [{ entity: 'x' }], ['text']])(
    'entity shape %p is unusable, never a crash (review focus 1)',
    (body) => expect(normaliseIdentity(body).usable).toBe(false),
  );

  it('never returns the phone or the photo', () => {
    expect(JSON.stringify(normaliseIdentity(bvn))).not.toMatch(/0801|removed/);
  });
});

describe('parseAmlResult (principles 3 and 4)', () => {
  it('the sandbox answer ("Unknown", results an object) is UNKNOWN with one PEP match', () => {
    const r = parseAmlResult(amlSandbox);
    expect(r.status).toBe('UNKNOWN');
    expect(r.entityId).toBe('d29d9974-08be-4789-89b7-879d17ca7f13');
    expect(r.category).toBe('PEP');
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]).toMatchObject({ name: 'John Doe Ajayi', positions: ['Commissioner'], sourceType: 'PEP', score: 0.91 });
  });

  it('only "No Match" with no results is CLEAR', () => {
    expect(parseAmlResult(amlNoMatch).status).toBe('CLEAR');
    expect(parseAmlResult({ entity: { ...amlNoMatch.entity, match_status: '  no match ' } }).status).toBe('CLEAR');
  });

  it('"No Match" that still carries a result is not clear', () => {
    expect(parseAmlResult({ entity: { ...amlNoMatch.entity, results: [{ name: 'x', source_type: 'PEP' }] } }).status).toBe('POSSIBLE_MATCH');
  });

  it('a confirmed sanctions match, keeping titles and URLs but not article text', () => {
    const r = parseAmlResult(amlConfirmed);
    expect(r).toMatchObject({ status: 'CONFIRMED_MATCH', category: 'SANCTIONS', entityId: 'sc-1' });
    expect(r.matches[0].articles).toEqual([{ title: 'Listed', url: 'https://example.test/a' }]);
    expect(JSON.stringify(r)).not.toContain('long article text');
  });

  it('a potential sanctions match is POSSIBLE_MATCH, category SANCTIONS', () => {
    expect(parseAmlResult(amlPossible)).toMatchObject({ status: 'POSSIBLE_MATCH', category: 'SANCTIONS' });
  });

  it.each([[undefined], [null], [{}], [{ entity: null }], [{ entity: { match_status: 42 } }], [{ entity: { match_status: 'Something New' } }]])(
    'shape %p is UNKNOWN, never clear',
    (body) => expect(parseAmlResult(body).status).toBe('UNKNOWN'),
  );

  it('caps what it keeps: at most 20 matches and 64-character statuses', () => {
    const many = { entity: { match_status: 'Potential Match' + 'x'.repeat(100), results: Array.from({ length: 50 }, () => ({ name: 'n' })) } };
    const r = parseAmlResult(many);
    expect(r.matches).toHaveLength(20);
    expect(r.matchStatus!.length).toBeLessThanOrEqual(64);
  });
});
