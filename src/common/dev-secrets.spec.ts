import { mayLogSecrets } from './dev-secrets';
import { UsersService } from '../users/users.service';

/**
 * M12 (PROJECT_REVIEW):
 *  - reset codes and invite links were written to the log on ANY server not
 *    set to "production", including a staging server with real testers;
 *  - /v1/me loaded the whole KYC row (identity hashes, date of birth, address)
 *    to use two fields.
 */
describe('M12: secrets reach the log only on a developer machine', () => {
  it.each([
    ['development', true],
    ['staging', false],
    ['test', false],
    ['production', false],
    [undefined, false],
  ])('NODE_ENV=%s → %s', (env, expected) => {
    expect(mayLogSecrets(env)).toBe(expected);
  });
});

describe('M12: /v1/me reads only what it shows', () => {
  it('asks the database for three KYC fields (date of birth since 28 Oct 2026), never the whole row', async () => {
    const findUnique = jest.fn(async () => ({
      id: 'u1', email: 'a@x', firstName: 'A', lastName: 'B', phone: null, status: 'ACTIVE', kycTier: 'TIER_0', kycStatus: 'NOT_STARTED',
      kycProfile: null, quidaxAccount: null, createdAt: new Date(),
    }));
    await new UsersService({ user: { findUnique } } as never).profile('u1');
    const args = (findUnique.mock.calls[0] as unknown as [{ include?: Record<string, unknown>; select?: Record<string, unknown> }])[0];
    const kyc = (args.select ?? args.include)?.kycProfile;
    expect(kyc).toEqual({ select: { rejectionReason: true, submittedAt: true, dateOfBirth: true } });
  });

  it('returns the verified date of birth as YYYY-MM-DD, or null before Basic verification', async () => {
    const base = {
      id: 'u1', email: 'a@x', firstName: 'A', lastName: 'B', phone: null, status: 'ACTIVE', kycTier: 'TIER_1', kycStatus: 'APPROVED',
      quidaxAccount: null, createdAt: new Date(),
    };
    const svc = (kycProfile: unknown) => new UsersService({ user: { findUnique: jest.fn(async () => ({ ...base, kycProfile })) } } as never);
    const verified = await svc({ rejectionReason: null, submittedAt: null, dateOfBirth: new Date('2000-05-01T00:00:00Z') }).profile('u1');
    expect(verified.dateOfBirth).toBe('2000-05-01');
    expect((await svc({ rejectionReason: null, submittedAt: null, dateOfBirth: null }).profile('u1')).dateOfBirth).toBeNull();
    expect((await svc(null).profile('u1')).dateOfBirth).toBeNull();
  });
});
