import { kycQueueQuery, AUTOMATED_TEST_DOMAIN } from './kyc-queue';

/** The KYC review list (26 Oct 2026): pages, newest/oldest first, search, and hiding automated-test accounts. */
describe('kycQueueQuery', () => {
  it('defaults: oldest first (fairest for a queue), page 1 of 25, automated-test accounts hidden', () => {
    const q = kycQueueQuery({});
    expect(q.order).toBe('oldest');
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(25);
    expect(q.orderBy).toEqual({ submittedAt: 'asc' });
    expect(q.skip).toBe(0);
    expect(q.take).toBe(25);
    expect(q.where).toEqual({ status: 'PENDING', user: { NOT: { email: { endsWith: AUTOMATED_TEST_DOMAIN } } } });
  });

  it('newest first, a later page, a bigger page size', () => {
    const q = kycQueueQuery({ order: 'newest', page: '3', pageSize: '50' });
    expect(q.orderBy).toEqual({ submittedAt: 'desc' });
    expect(q.skip).toBe(100);
    expect(q.take).toBe(50);
  });

  it('search matches email, first or last name, ignoring case', () => {
    const q = kycQueueQuery({ search: '  Ada ' });
    expect(q.where.user).toEqual({
      NOT: { email: { endsWith: AUTOMATED_TEST_DOMAIN } },
      OR: [
        { email: { contains: 'Ada', mode: 'insensitive' } },
        { firstName: { contains: 'Ada', mode: 'insensitive' } },
        { lastName: { contains: 'Ada', mode: 'insensitive' } },
      ],
    });
  });

  it('automated-test accounts can be shown on purpose', () => {
    expect(kycQueueQuery({ includeAutomatedTests: 'true' }).where).toEqual({ status: 'PENDING' });
  });

  it('bad values fall back safely: never page 0, never more than 100 a page, unknown order is oldest', () => {
    const q = kycQueueQuery({ order: 'sideways', page: '-4', pageSize: '100000' });
    expect(q.order).toBe('oldest');
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(100);
    expect(kycQueueQuery({ page: 'abc', pageSize: '0' })).toMatchObject({ page: 1, pageSize: 25 });
  });
});
