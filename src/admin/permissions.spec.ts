import {
  ALL_PERMISSIONS,
  DEFAULT_SUB_ADMIN_PERMISSIONS,
  PERMISSION_GROUPS,
  isPermission,
} from './permissions';

/**
 * The permission list is a security boundary, so its shape matters as much as
 * its contents: a duplicate key would let one grant be revoked while another
 * silently kept it, and a default that includes a write permission would hand
 * every new sub-admin more than whoever added them intended.
 */
describe('permission catalogue', () => {
  it('has no duplicate keys', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('recognises only keys it defines', () => {
    for (const key of ALL_PERMISSIONS) expect(isPermission(key)).toBe(true);

    // The shapes a typo or an injection attempt actually takes.
    for (const bogus of ['', 'users', 'users.*', 'USERS.VIEW', 'users.view ', '__proto__']) {
      expect(isPermission(bogus)).toBe(false);
    }
  });

  it('gives every permission a label a person can read', () => {
    for (const group of PERMISSION_GROUPS) {
      expect(group.label.length).toBeGreaterThan(0);
      for (const p of group.permissions) {
        expect(p.label.length).toBeGreaterThan(3);
        // The key is machine-facing; the label must not just repeat it.
        expect(p.label).not.toBe(p.key);
      }
    }
  });

  it('defaults a new sub-admin to reading only', () => {
    for (const key of DEFAULT_SUB_ADMIN_PERMISSIONS) {
      expect(isPermission(key)).toBe(true);
      // Nothing that changes state, moves money, or manages people.
      expect(key).toMatch(/\.view$/);
    }
  });

  it('splits seeing from doing wherever there is something to do', () => {
    // If a feature can be acted on, reading it must be grantable separately —
    // otherwise "let them look at users" also means "let them suspend one".
    for (const managed of ['users.manage', 'fees.manage', 'claims.manage', 'inventory.manage']) {
      const area = managed.split('.')[0];
      expect(ALL_PERMISSIONS).toContain(`${area}.view`);
      expect(ALL_PERMISSIONS).toContain(managed);
    }
  });
});
