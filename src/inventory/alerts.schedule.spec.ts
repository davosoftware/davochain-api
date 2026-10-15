import { AlertsService } from './alerts.service';

/**
 * M10 (PROJECT_REVIEW):
 *  - the alert jobs ran on every server copy: two servers, two of every alert;
 *  - the daily digest was fixed at 07:00 server time, ignoring
 *    DAILY_DIGEST_HOUR and DIGEST_TIMEZONE.
 */
function build(hour = 7, tz = 'Africa/Lagos') {
  const runs: Array<{ name: string; keep?: boolean }> = [];
  const leases = {
    run: jest.fn(async (name: string, _ttl: number, fn: () => Promise<unknown>, opts?: { keep?: boolean }) => {
      runs.push({ name, keep: opts?.keep });
      return { ran: true, result: await fn() };
    }),
  };
  const config = { get: (k: string) => ({ DAILY_DIGEST_HOUR: hour, DIGEST_TIMEZONE: tz })[k] };
  const svc = new AlertsService({} as never, {} as never, config as never, {} as never, { list: jest.fn() } as never, leases as never);
  const work = {
    dailyDigest: jest.spyOn(svc, 'dailyDigest').mockResolvedValue(undefined),
    dipWatch: jest.spyOn(svc, 'dipWatch').mockResolvedValue(undefined),
    fuelWatch: jest.spyOn(svc, 'fuelWatch').mockResolvedValue(undefined),
    inventoryWatch: jest.spyOn(svc, 'inventoryWatch').mockResolvedValue(undefined),
  };
  return { svc, runs, work };
}

describe('M10: the daily digest goes out at the configured hour, in the configured time zone', () => {
  it('07:00 in Lagos is 06:00 UTC: sent', async () => {
    const { svc, work } = build(7, 'Africa/Lagos');
    await svc.digestTick(new Date('2026-10-15T06:00:00Z'));
    expect(work.dailyDigest).toHaveBeenCalledTimes(1);
  });

  it('07:00 UTC is 08:00 in Lagos: not sent', async () => {
    const { svc, work } = build(7, 'Africa/Lagos');
    await svc.digestTick(new Date('2026-10-15T07:00:00Z'));
    expect(work.dailyDigest).not.toHaveBeenCalled();
  });

  it('a different hour and time zone are honoured', async () => {
    const { svc, work } = build(9, 'Europe/London'); // 09:00 BST = 08:00 UTC in October
    await svc.digestTick(new Date('2026-10-15T08:00:00Z'));
    expect(work.dailyDigest).toHaveBeenCalledTimes(1);
  });
});

describe('M10: each alert job runs on one server only', () => {
  it.each([
    ['digestTick', 'daily-digest', '2026-10-15T06:00:00Z'],
    ['dipWatchCron', 'dip-watch', undefined],
    ['fuelWatchCron', 'fuel-watch', undefined],
    ['inventoryWatchCron', 'inventory-watch', undefined],
  ])('%s runs under the "%s" lease, kept until it expires', async (method, lease, at) => {
    const { svc, runs } = build();
    await (svc as unknown as Record<string, (d?: Date) => Promise<void>>)[method](at ? new Date(at) : undefined);
    expect(runs).toEqual([{ name: lease, keep: true }]);
  });
});
