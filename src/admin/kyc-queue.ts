import type { Prisma } from '@prisma/client';

/**
 * The KYC review list's paging, order, search and test-account filter
 * (26 Oct 2026). Before this the list was the oldest 100 with no total, so the
 * 101st person waiting simply never appeared.
 */

/** Accounts the automated tests create. Never a real customer (live has none). */
export const AUTOMATED_TEST_DOMAIN = '@davochain.invalid';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export interface KycQueueParams {
  order?: string;
  page?: string;
  pageSize?: string;
  search?: string;
  includeAutomatedTests?: string;
}

const whole = (v: string | undefined) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
};

export function kycQueueQuery(p: KycQueueParams) {
  const order: 'oldest' | 'newest' = p.order === 'newest' ? 'newest' : 'oldest';
  const page = whole(p.page) >= 1 ? whole(p.page) : 1;
  const size = whole(p.pageSize);
  const pageSize = size >= 1 ? Math.min(size, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const search = (p.search ?? '').trim().slice(0, 100);

  const user: Prisma.UserWhereInput = {};
  if (p.includeAutomatedTests !== 'true') user.NOT = { email: { endsWith: AUTOMATED_TEST_DOMAIN } };
  if (search) {
    user.OR = [
      { email: { contains: search, mode: 'insensitive' } },
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
    ];
  }
  const where: Prisma.KycProfileWhereInput = { status: 'PENDING', ...(Object.keys(user).length ? { user } : {}) };

  return {
    order,
    page,
    pageSize,
    where,
    orderBy: { submittedAt: order === 'newest' ? 'desc' : 'asc' } as const,
    skip: (page - 1) * pageSize,
    take: pageSize,
  };
}
