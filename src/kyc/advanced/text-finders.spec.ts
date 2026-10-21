import { addressInText, findDates, latestDate, nameInText, toIsoDate, withinMonths } from './text-finders';

describe('findDates (spec §7.3)', () => {
  it('reads the common Nigerian formats', () => {
    expect(findDates('Issued 25/09/2026')).toEqual([['2026-09-25']]);
    expect(findDates('Date: 25-09-2026')).toEqual([['2026-09-25']]);
    expect(findDates('12 March 2026')).toEqual([['2026-03-12']]);
    expect(findDates('12th Mar, 2026')).toEqual([['2026-03-12']]);
    expect(findDates('March 12, 2026')).toEqual([['2026-03-12']]);
    expect(findDates('2026-03-12')).toEqual([['2026-03-12']]);
  });
  it('gives both readings when day and month could swap, day first', () => {
    expect(findDates('03/04/2026')).toEqual([['2026-04-03', '2026-03-04']]);
    expect(findDates('05/05/2026')).toEqual([['2026-05-05']]);
  });
  it('ignores impossible dates', () => {
    expect(findDates('31/02/2026 and 45/13/2026')).toEqual([]);
  });
  it('keeps the order the dates appear in', () => {
    expect(findDates('from 1 January 2025 to 31/12/2027')).toEqual([['2025-01-01'], ['2027-12-31']]);
  });
});

describe('toIsoDate', () => {
  it('reads an ID field, day first', () => {
    expect(toIsoDate('03/04/1995')).toBe('1995-04-03');
    expect(toIsoDate('1995-03-03')).toBe('1995-03-03');
    expect(toIsoDate('03 MAR 1995')).toBe('1995-03-03');
    expect(toIsoDate('')).toBeNull();
    expect(toIsoDate(null)).toBeNull();
  });
});

describe('latestDate', () => {
  const today = '2026-10-21';
  it('takes the latest past date, and the earlier reading of an ambiguous one', () => {
    expect(latestDate('from 01/01/2026 to 03/09/2026', today, { allowFuture: false })).toBe('2026-03-09');
  });
  it('skips future dates unless allowed', () => {
    // 01/02/2026 is 1 Feb or 2 Jan: the earlier reading counts (spec §7.3).
    expect(latestDate('12/12/2027 and 01/02/2026', today, { allowFuture: false })).toBe('2026-01-02');
    expect(latestDate('12/12/2027 and 01/02/2026', today, { allowFuture: true })).toBe('2027-12-12');
  });
  it('is null with no date', () => {
    expect(latestDate('no dates here', today, { allowFuture: false })).toBeNull();
  });
});

describe('withinMonths', () => {
  it('counts calendar months back from today, inclusive', () => {
    expect(withinMonths('2026-07-21', '2026-10-21', 3)).toBe(true);
    expect(withinMonths('2026-07-20', '2026-10-21', 3)).toBe(false);
  });
  it('handles a month with fewer days', () => {
    expect(withinMonths('2026-02-28', '2026-05-31', 3)).toBe(true);
    expect(withinMonths('2026-02-27', '2026-05-31', 3)).toBe(false);
  });
});

describe('nameInText', () => {
  const name = { firstName: 'Someone', lastName: 'Clean' };
  it('finds both names as whole words, ignoring case and accents', () => {
    expect(nameInText('ACCOUNT NAME: CLEAN, SOMEONE', name)).toBe('FULL');
    expect(nameInText('Sómeone Cléan', name)).toBe('FULL');
  });
  it('is partial with one name and none with neither', () => {
    expect(nameInText('Mr Someone Other', name)).toBe('PARTIAL');
    expect(nameInText('Someoneclean', name)).toBe('NONE');
  });
  it('needs every word of a two-word name', () => {
    expect(nameInText('Mary Ann Okafor', { firstName: 'Mary Ann', lastName: 'Okafor' })).toBe('FULL');
    expect(nameInText('Mary Okafor', { firstName: 'Mary Ann', lastName: 'Okafor' })).toBe('PARTIAL');
  });
});

describe('addressInText', () => {
  const addr = { street: '1 E2E Street', city: 'Ikeja', state: 'Lagos' };
  it('matches with the state and the street words or city', () => {
    expect(addressInText('1 E2E STREET, IKEJA, LAGOS STATE', addr)).toBe('MATCH');
    expect(addressInText('Somewhere, Ikeja, Lagos', addr)).toBe('MATCH');
  });
  it('is partial with only the state, none without it', () => {
    expect(addressInText('9 Other Road, Lekki, Lagos', addr)).toBe('PARTIAL');
    expect(addressInText('1 E2E Street, Ikeja, Ogun', addr)).toBe('NONE');
  });
  it('reads Abuja as the FCT', () => {
    expect(addressInText('Plot 5, Garki, Abuja', { street: 'Plot 5', city: 'Garki', state: 'FCT' })).toBe('MATCH');
  });
  it('is none when no address was typed at Basic', () => {
    expect(addressInText('anything Lagos', { street: null, city: null, state: null })).toBe('NONE');
  });
});
