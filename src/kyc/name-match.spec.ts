import { cleanName, matchIdentity } from './name-match';

const rec = (first: string, last: string, middle: string | null = null, dob = '2000-05-01') => ({
  usable: true, firstName: first, middleName: middle, lastName: last, dateOfBirth: dob, gender: 'MALE' as const, customerRef: null,
});

describe('cleanName (spec §5)', () => {
  it.each([
    ['Adébáyọ̀', 'adebayo'],
    ["O'Neil-Smith", 'oneilsmith'],
    ['  JOHN  ', 'john'],
    ['Ọlá', 'ola'],
  ])('%p → %p', (a, b) => expect(cleanName(a)).toBe(b));
});

describe('matchIdentity (review focus 2)', () => {
  it('matches after cleanup', () => {
    expect(matchIdentity({ firstName: 'adebayo', lastName: "o'neil smith", dateOfBirth: '2000-05-01' }, rec('ADÉBÁYỌ̀', 'ONEIL-SMITH')).matched).toBe(true);
  });

  it('allows first and last swapped, and says so', () => {
    const r = matchIdentity({ firstName: 'Ajayi', lastName: 'John', dateOfBirth: '2000-05-01' }, rec('JOHN', 'AJAYI'));
    expect(r.matched).toBe(true);
    expect(r.swapped).toBe(true);
  });

  it('compares middle names only when both sides have one', () => {
    expect(matchIdentity({ firstName: 'John', lastName: 'Ajayi', dateOfBirth: '2000-05-01' }, rec('John', 'Ajayi', 'Doe')).fields.middleName).toBe('SKIPPED');
    const r = matchIdentity({ firstName: 'John', middleName: 'Peter', lastName: 'Ajayi', dateOfBirth: '2000-05-01' }, rec('John', 'Ajayi', 'Doe'));
    expect(r.fields.middleName).toBe('MISMATCH');
    expect(r.matched).toBe(false);
  });

  it('a different first name does not match', () => {
    const r = matchIdentity({ firstName: 'Jon', lastName: 'Ajayi', dateOfBirth: '2000-05-01' }, rec('John', 'Ajayi'));
    expect(r).toMatchObject({ matched: false, fields: { firstName: 'MISMATCH', lastName: 'MATCH' } });
  });

  it('a different date of birth does not match', () => {
    expect(matchIdentity({ firstName: 'John', lastName: 'Ajayi', dateOfBirth: '2000-05-02' }, rec('John', 'Ajayi')).fields.dateOfBirth).toBe('MISMATCH');
  });

  it('an unusable record never matches', () => {
    expect(matchIdentity({ firstName: 'John', lastName: 'Ajayi', dateOfBirth: '2000-05-01' }, { ...rec('John', 'Ajayi'), usable: false, dateOfBirth: null }).matched).toBe(false);
  });

  it('a name that cleans to nothing never matches', () => {
    expect(matchIdentity({ firstName: '---', lastName: 'Ajayi', dateOfBirth: '2000-05-01' }, rec('---', 'Ajayi')).matched).toBe(false);
  });
});
