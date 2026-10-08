import { nameMatches } from './name-match';

describe('nameMatches', () => {
  it('matches regardless of order, case, punctuation and extra names', () => {
    expect(nameMatches('Ada', 'Obi', 'ADA OBI')).toBe(true);
    expect(nameMatches('Ada', 'Obi', 'OBI ADA CHIOMA')).toBe(true);
    expect(nameMatches('Ada', 'Obi', 'Obi, Ada')).toBe(true);
  });

  it('refuses a different person, or an initial in place of a name', () => {
    expect(nameMatches('Ada', 'Obi', 'JOHN DOE')).toBe(false);
    expect(nameMatches('Ada', 'Obi', 'A. OBI')).toBe(false);
  });

  it('ignores accents', () => {
    expect(nameMatches('Adebayo', 'Okonkwo', 'ADÉBÁYỌ̀ OKONKWO')).toBe(true);
  });

  it('handles hyphenated names', () => {
    expect(nameMatches('Mary-Jane', 'Doe', 'MARY JANE DOE')).toBe(true);
  });

  it('has no opinion when the sender name is missing or N/A', () => {
    expect(nameMatches('Ada', 'Obi', null)).toBeNull();
    expect(nameMatches('Ada', 'Obi', '')).toBeNull();
    expect(nameMatches('Ada', 'Obi', 'N/A')).toBeNull();
  });

  it('has no opinion when the user has no usable name', () => {
    expect(nameMatches('A', 'B', 'ADA OBI')).toBeNull();
  });
});
