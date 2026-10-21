import { localNigerianPhone } from './phone';

describe('localNigerianPhone (Payrep wants 080…, at most 11 characters)', () => {
  it.each([
    ['+2348012345678', '08012345678'],
    ['2348012345678', '08012345678'],
    ['08012345678', '08012345678'],
    ['8012345678', '08012345678'],
    ['+234 801 234 5678', '08012345678'],
    ['+447700900123', undefined],
    ['123', undefined],
    ['', undefined],
    [null, undefined],
  ])('%s → %s', (input, out) => expect(localNigerianPhone(input as string | null)).toBe(out));
});
