import { checkPayUsername, displayName } from './pay-username';

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
