import { checkPayUsername, displayName, generatePayUsername } from './pay-username';

/** The payment username rules (decisions 28 Oct 2026). */
describe('checkPayUsername', () => {
  const ok = (v: string) => expect(checkPayUsername(v)).toMatchObject({ ok: true });
  const no = (v: string) => checkPayUsername(v).reason;

  it('takes letters, numbers, _ and -, 7 to 20 characters', () => {
    ok('ada_okafor');
    ok('chi-2026');
    ok('abcdefg');
    ok('a'.repeat(20));
  });

  it('saves it in lower case, so capitals never make two people', () => {
    expect(checkPayUsername('  Ada_Okafor ').value).toBe('ada_okafor');
  });

  it('a leading @ is ignored, as people type it that way', () => {
    expect(checkPayUsername('@ada_okafor')).toMatchObject({ ok: true, value: 'ada_okafor' });
  });

  it('needs at least 7 characters', () => {
    expect(no('adaokf')).toMatch(/at least 7 characters/);
  });

  it('allows at most 20 characters', () => {
    expect(no('a'.repeat(21))).toMatch(/at most 20 characters/);
  });

  it('refuses spaces and other symbols, and says which', () => {
    expect(no('ada okafor')).toMatch(/no spaces/);
    expect(no('ada.okafor')).toMatch(/letters, numbers, _ and -/);
    expect(no('adá_okafor')).toMatch(/letters, numbers, _ and -/);
  });

  it('needs a letter, and must start and end with a letter or number', () => {
    expect(no('12345678')).toMatch(/at least one letter/);
    expect(no('_adaokafor')).toMatch(/start and end/);
    expect(no('adaokafor-')).toMatch(/start and end/);
  });

  it('refuses names that look official', () => {
    for (const bad of ['davochain_ng', 'the_admin1', 'support-team', 'official_ada', 'quidaxpay']) {
      expect(no(bad)).toMatch(/looks official/);
    }
  });

  it('empty is a clear message', () => {
    expect(no('')).toMatch(/Choose a username/);
  });
});

describe('displayName: what a sender sees before confirming', () => {
  it('first name and the last initial only', () => {
    expect(displayName({ firstName: 'Ada', lastName: 'Okafor' })).toBe('Ada O.');
    expect(displayName({ firstName: 'Ada', lastName: '' })).toBe('Ada');
  });
});

describe('generatePayUsername: firstname_digits for every new customer (28 Oct 2026)', () => {
  const nines = (n: number) => '9'.repeat(n);
  const fixed = (d: string) => (n: number) => d.slice(0, n).padEnd(n, '0');

  it('the first name in lower case, an underscore, and 4 random digits', () => {
    expect(generatePayUsername('Ada', fixed('4821'))).toBe('ada_4821');
    expect(generatePayUsername('Chukwuemeka', fixed('0042'))).toBe('chukwuemeka_0042');
  });

  it('always at least 7 characters: a short name gets more digits', () => {
    expect(generatePayUsername('Jo', fixed('12345'))).toBe('jo_1234');
    expect(generatePayUsername('O', fixed('123456'))).toBe('o_12345');
  });

  it('never more than 20: a long name is cut', () => {
    const name = generatePayUsername('Oluwadamilarekehinde', fixed('1234'));
    expect(name).toBe('oluwadamilareke_1234');
    expect(name.length).toBeLessThanOrEqual(20);
  });

  it('more digits when asked (after clashes)', () => {
    expect(generatePayUsername('Ada', fixed('12345678'), 8)).toBe('ada_12345678');
  });

  it('accents are folded, spaces and symbols dropped', () => {
    expect(generatePayUsername('Chiamaká', fixed('1111'))).toBe('chiamaka_1111');
    expect(generatePayUsername("Mary-Jane O'Neil", fixed('1111'))).toBe('maryjaneoneil_1111');
  });

  it('a name with no usable letters, or one that looks official, becomes "user"', () => {
    expect(generatePayUsername('😀', fixed('1234'))).toBe('user_1234');
    expect(generatePayUsername('123', fixed('1234'))).toBe('user_1234');
    expect(generatePayUsername('Davo', fixed('1234'))).toBe('user_1234');
    expect(generatePayUsername('Admin', fixed('1234'))).toBe('user_1234');
  });

  it('what it makes always passes the username rules', () => {
    for (const n of ['A', 'Ada', 'Jo', 'Oluwadamilarekehinde', '😀', 'Chiamaká', 'X Æ A-12']) {
      for (const min of [4, 6, 8]) expect(checkPayUsername(generatePayUsername(n, nines, min)).ok).toBe(true);
    }
  });

  it('real random digits by default', () => {
    expect(generatePayUsername('Ada')).toMatch(/^ada_\d{4}$/);
  });
});
