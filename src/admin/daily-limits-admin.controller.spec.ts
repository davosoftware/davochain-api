import { PolicyAction } from '@prisma/client';
import { DailyLimitsAdminController } from './daily-limits-admin.controller';

/** People → Daily limits (27 Oct 2026): paged list and one customer's day. */
function build(count: number) {
  const customers = Array.from({ length: count }, (_, i) => ({ userId: `u${i}`, email: `c${i}@x.com`, highestPercent: 100 - i }));
  const usage = { forDay: jest.fn(async () => ({ date: '2026-10-27', ngnPerUsd: '1500.00', customers })) };
  return { ctl: new DailyLimitsAdminController(usage as never), usage };
}

describe('Admin: daily limits', () => {
  it('pages the customers (25 by default) and passes the filters on', async () => {
    const { ctl, usage } = build(30);
    const r = await ctl.list({ date: '2026-10-27', near: '80', action: 'BUY', search: 'ada', page: '2' });
    expect(usage.forDay).toHaveBeenCalledWith({ date: '2026-10-27', nearPercent: 80, action: PolicyAction.BUY, search: 'ada' });
    expect(r).toMatchObject({ date: '2026-10-27', total: 30, page: 2, pageSize: 25 });
    expect(r.customers.map((c: { userId: string }) => c.userId)).toEqual(['u25', 'u26', 'u27', 'u28', 'u29']);
  });

  it('one customer\'s day, for the Users page', async () => {
    const { ctl, usage } = build(1);
    const r = await ctl.forUser('u0', { date: undefined });
    expect(usage.forDay).toHaveBeenCalledWith({ date: undefined, userId: 'u0' });
    expect(r).toMatchObject({ date: '2026-10-27', customer: { userId: 'u0' } });
  });
});
