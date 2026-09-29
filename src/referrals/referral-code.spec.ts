import {
  CODE_LENGTH,
  checkUsername,
  generateReferralCode,
  normaliseCode,
  referralLink,
} from './referral-code';

describe('generateReferralCode', () => {
  it('starts with the name and fills the rest', () => {
    const code = generateReferralCode('Ada', () => 0);
    expect(code).toBe('ADA2222'); // '2' is the first character of the alphabet
    expect(code).toHaveLength(CODE_LENGTH);
  });

  it('is always the full length, whatever the name', () => {
    for (const name of ['Ada', 'Bo', 'X', 'Chukwuemeka', '', '  ', '🙂', '李']) {
      expect(generateReferralCode(name, () => 0)).toHaveLength(CODE_LENGTH);
    }
  });

  it('folds accents so the same name gives the same stem', () => {
    const plain = generateReferralCode('Chiamaka', () => 0);
    const accented = generateReferralCode('Chiamaká', () => 0);
    expect(accented.slice(0, 3)).toBe(plain.slice(0, 3));
    expect(accented.slice(0, 3)).toBe('CHI');
  });

  it('falls back rather than producing a short code', () => {
    // A name with no Latin letters still has to yield something shareable,
    // and the length is what carries the randomness.
    expect(generateReferralCode('李雷', () => 0)).toBe('DVC2222');
    expect(generateReferralCode('', () => 0)).toBe('DVC2222');
  });

  it('never emits a character that can be misread', () => {
    // 0/O and 1/I/L are the pairs that turn a shared code into a wrong signup,
    // and a wrong signup pays the wrong person.
    const codes = Array.from({ length: 400 }, () => generateReferralCode('Zzz'));
    for (const code of codes) {
      expect(code.slice(3)).not.toMatch(/[01OIL]/);
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateReferralCode('Ada')));
    // 31^4 is ~923k, so 500 draws colliding more than a couple of times would
    // mean the randomness is not doing its job.
    expect(seen.size).toBeGreaterThan(495);
  });
});

describe('normaliseCode', () => {
  it('is case and whitespace insensitive, because people paste', () => {
    expect(normaliseCode('  ada4k7  ')).toBe('ADA4K7');
    expect(normaliseCode('Ada4K7')).toBe('ADA4K7');
  });
});

describe('checkUsername', () => {
  const ok = (v: string) => expect(checkUsername(v).ok).toBe(true);
  const no = (v: string) => checkUsername(v).reason;

  it('accepts a reasonable one', () => {
    ok('adaobi');
    ok('ADA123');
    ok('Bo1');
  });

  it('stores it upper-cased, so ADAOBI and adaobi are one name', () => {
    expect(checkUsername('adaobi').value).toBe('ADAOBI');
  });

  it('holds the 7-character ceiling', () => {
    ok('SEVENCH');
    expect(no('EIGHTCHR')).toMatch(/at most 7/);
  });

  it('refuses one too short to be worth typing', () => {
    expect(no('ab')).toMatch(/at least 3/);
    expect(no('')).toMatch(/Choose a username/);
  });

  it('refuses anything that would not survive a URL', () => {
    expect(no('ada obi')).toMatch(/Letters and numbers only/);
    expect(no('ada-obi')).toMatch(/Letters and numbers only/);
    expect(no('adaobí')).toMatch(/Letters and numbers only/);
    expect(no('ada/../')).toMatch(/Letters and numbers only/);
  });

  it('refuses an all-digit username', () => {
    // It would read as an account number, and it collides with nothing useful.
    expect(no('12345')).toMatch(/at least one letter/);
  });

  it('refuses names that would read as ours', () => {
    // davochain.com/r/SUPPORT has to not be a person.
    expect(no('admin')).toMatch(/reserved/);
    expect(no('SUPPORT')).toMatch(/reserved/);
    expect(no('system')).toMatch(/reserved/);
    expect(no('www')).toMatch(/reserved/);
  });

  it('says WHY, every time it says no', () => {
    for (const bad of ['', 'ab', 'EIGHTCHR', 'ada obi', '12345', 'admin']) {
      const verdict = checkUsername(bad);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toBeTruthy();
      expect(verdict.reason!.length).toBeGreaterThan(10);
    }
  });
});

describe('referralLink', () => {
  it('builds a link a person can send', () => {
    expect(referralLink('https://davochain.com', 'ADA4K7')).toBe(
      'https://davochain.com/r/ADA4K7',
    );
  });

  it('does not double the slash when the base has one', () => {
    expect(referralLink('https://davochain.com/', 'ADA4K7')).toBe(
      'https://davochain.com/r/ADA4K7',
    );
  });
});
