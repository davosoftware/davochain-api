import { JobLeaseService } from './job-lease.service';

function service(acquired: boolean) {
  const calls: string[] = [];
  const prisma = {
    $queryRaw: jest.fn(async () => {
      calls.push('acquire');
      return acquired ? [{ name: 'job' }] : [];
    }),
    $executeRaw: jest.fn(async () => {
      calls.push('release');
      return 1;
    }),
  };
  return { svc: new JobLeaseService(prisma as never), prisma, calls };
}

describe('JobLeaseService', () => {
  it('runs the job and releases the lease when it wins', async () => {
    const { svc, calls } = service(true);
    const fn = jest.fn(async () => 42);
    await expect(svc.run('job', 60_000, fn)).resolves.toEqual({ ran: true, result: 42 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['acquire', 'release']);
  });

  it('skips the job when another runner holds the lease', async () => {
    const { svc, calls } = service(false);
    const fn = jest.fn(async () => 42);
    await expect(svc.run('job', 60_000, fn)).resolves.toEqual({ ran: false });
    expect(fn).not.toHaveBeenCalled();
    expect(calls).toEqual(['acquire']);
  });

  it('releases the lease even when the job throws', async () => {
    const { svc, calls } = service(true);
    await expect(svc.run('job', 60_000, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(calls).toEqual(['acquire', 'release']);
  });
});
