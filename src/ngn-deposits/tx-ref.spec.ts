import { hasOurPrefix, isOurTxRef, txRefForUser, userIdFromTxRef } from './tx-ref';

describe('virtual-account tx refs', () => {
  it('is dcva_ plus the user id, lower case, without dashes', () => {
    expect(txRefForUser('7F3C2A1B-9E8D-4C6F-A1B2-C3D4E5F60718')).toBe('dcva_7f3c2a1b9e8d4c6fa1b2c3d4e5f60718');
  });

  it('maps back to the user id', () => {
    expect(userIdFromTxRef('dcva_7f3c2a1b9e8d4c6fa1b2c3d4e5f60718')).toBe('7f3c2a1b-9e8d-4c6f-a1b2-c3d4e5f60718');
    expect(isOurTxRef('dcva_7f3c2a1b9e8d4c6fa1b2c3d4e5f60718')).toBe(true);
  });

  it('refuses anything else', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'dcva_',
      'dcva_xyz',
      'dcbt_spike_ead46a4d',
      'dcva_7f3c2a1b9e8d4c6fa1b2c3d4e5f6071',
      'dcva_7f3c2a1b9e8d4c6fa1b2c3d4e5f60718x',
      'DCVA_7f3c2a1b9e8d4c6fa1b2c3d4e5f60718',
    ]) {
      expect(userIdFromTxRef(bad)).toBeNull();
      expect(isOurTxRef(bad)).toBe(false);
    }
  });

  it('recognises our prefix, even on a malformed ref', () => {
    expect(hasOurPrefix('dcva_anything')).toBe(true);
    expect(hasOurPrefix('dcbt_x')).toBe(false);
    expect(hasOurPrefix(null)).toBe(false);
  });
});
