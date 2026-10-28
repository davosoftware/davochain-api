import { UsersService } from './users.service';

describe('GET /v1/me: payment username (28 Oct 2026)', () => {
  it('shows it, or null when none is chosen', async () => {
    const base = { id: 'u1', email: 'a@b.c', firstName: 'A', lastName: 'B', phone: null, status: 'ACTIVE', emailVerifiedAt: null, kycTier: 'TIER_0', kycStatus: 'NONE', kycProfile: null, quidaxAccount: null, createdAt: new Date() };
    const svc = (u: object) => new UsersService({ user: { findUnique: jest.fn(async () => u) } } as never);
    expect((await svc({ ...base, payUsername: 'ada_okafor' }).profile('u1')).payUsername).toBe('ada_okafor');
    expect((await svc({ ...base, payUsername: null }).profile('u1')).payUsername).toBeNull();
  });
});
