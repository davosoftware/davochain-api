import { DojahMockClient } from './dojah.mock';

const m = () => new DojahMockClient();

describe('DojahMockClient scenarios (principle 5)', () => {
  it('clean BVN and NIN are the sandbox records', async () => {
    expect(await m().lookup('BVN', '22222222222')).toMatchObject({ found: true, identity: { lastName: 'Ajayi', dateOfBirth: '2000-05-01' } });
    expect(await m().lookup('NIN', '70123456789')).toMatchObject({ found: true, identity: { dateOfBirth: '1990-01-01' } });
  });
  it('404, unusable and mismatch records', async () => {
    expect(await m().lookup('BVN', '11111111111')).toEqual({ found: false, httpStatus: 404 });
    expect(await m().lookup('BVN', '55555555555')).toMatchObject({ identity: { usable: false } });
    expect(await m().lookup('BVN', '33333333333')).toMatchObject({ identity: { firstName: 'Someone' } });
  });
  it.each([['40100000001', 'AUTH'], ['40300000001', 'IP'], ['40200000001', 'WALLET'], ['50000000001', 'SERVER'], ['99999999999', 'UNKNOWN']])(
    '%s throws %s',
    async (n, kind) => expect(m().lookup('BVN', n)).rejects.toMatchObject({ kind }),
  );
  it.each([['John Doe Ajayi', 'UNKNOWN', 'PEP'], ['A Clean', 'CLEAR', null], ['A Pep', 'POSSIBLE_MATCH', 'PEP'], ['A Sanctioned', 'CONFIRMED_MATCH', 'SANCTIONS'], ['A Maybesanctioned', 'POSSIBLE_MATCH', 'SANCTIONS']])(
    'AML for %s is %s',
    async (names, status, category) =>
      expect((await m().screen({ names, date_of_birth: '2000-05-01', nationality: 'NG' }, 'r')).parsed).toMatchObject({ status, category }),
  );
  it('AML failures and counting', async () => {
    const c = m();
    await expect(c.screen({ names: 'A Amlerror', date_of_birth: '2000-05-01', nationality: 'NG' }, 'r')).rejects.toMatchObject({ kind: 'SERVER' });
    await expect(c.screen({ names: 'A Amltimeout', date_of_birth: '2000-05-01', nationality: 'NG' }, 'r')).rejects.toMatchObject({ kind: 'UNKNOWN' });
    expect(c.calls.aml).toBe(2);
  });
});

describe('mock identities whose AML screen reaches the sanctions paths (AML screens the RECORD names)', () => {
  it('66666666666 is "Test Sanctioned" (confirmed sanctions); 77777777777 is "Test Maybesanctioned" (possible)', async () => {
    const c = m();
    const a = await c.lookup('BVN', '66666666666');
    const b = await c.lookup('BVN', '77777777777');
    expect(a).toMatchObject({ found: true, identity: { firstName: 'Test', lastName: 'Sanctioned', usable: true } });
    expect(b).toMatchObject({ found: true, identity: { lastName: 'Maybesanctioned', usable: true } });
  });
});

/**
 * H8 made one BVN/NIN verify one account. Tests that create many accounts need
 * many numbers that still mean "the clean person" or "the sanctioned person",
 * so the mock reads a number by its first three digits when it is not one of
 * the exact special numbers.
 */
describe('DojahMockClient: number families (H8)', () => {
  it.each([
    ['33312345678', 'Someone', 'Clean'],
    ['22298765432', 'John', 'Ajayi'],
    ['66600000001', 'Test', 'Sanctioned'],
    ['77700000001', 'Test', 'Maybesanctioned'],
  ])('%s reads as its family', async (num, first, last) => {
    const r = await new DojahMockClient().lookup('BVN', num);
    expect(r).toMatchObject({ found: true, identity: { firstName: first, lastName: last } });
  });

  it('the exact special numbers keep their meaning', async () => {
    await expect(new DojahMockClient().lookup('BVN', '11111111111')).resolves.toMatchObject({ found: false });
    await expect(new DojahMockClient().lookup('BVN', '40200000001')).rejects.toBeDefined();
  });
});
