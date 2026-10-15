import { createHash } from 'node:crypto';
import { UserOtpService } from './user-otp.service';
import { AdminOtpService } from '../admin/otp.service';

/**
 * C5 (PROJECT_REVIEW): a reset code is capped at five tries, and the cap has to
 * hold when the tries arrive all at once, not only one after another.
 *
 * The fake table yields on every call, the way a real database round-trip does,
 * so parallel requests genuinely interleave. Each single call is atomic, which
 * is what Postgres guarantees for one UPDATE … WHERE.
 */
type Row = { id: string; codeHash: string; attempts: number; consumedAt: Date | null; expiresAt: Date; createdAt: Date };

const tick = () => new Promise((r) => setImmediate(r));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function fakeTable(row: Row) {
  const matches = (where: Record<string, any>) =>
    (where.id === undefined || where.id === row.id) &&
    (!('consumedAt' in where) || (where.consumedAt === null ? row.consumedAt === null : true)) &&
    (where.attempts?.lt === undefined || row.attempts < where.attempts.lt) &&
    (where.expiresAt?.gt === undefined || row.expiresAt > where.expiresAt.gt);
  const apply = (data: Record<string, any>) => {
    if (data.attempts?.increment) row.attempts += data.attempts.increment;
    if ('consumedAt' in data) row.consumedAt = data.consumedAt;
  };
  return {
    row,
    findFirst: jest.fn(async ({ where }: any) => {
      await tick();
      return where.consumedAt === null && row.consumedAt !== null ? null : { ...row };
    }),
    findUnique: jest.fn(async () => {
      await tick();
      return { ...row };
    }),
    update: jest.fn(async ({ data }: any) => {
      await tick();
      apply(data);
      return { ...row };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      await tick();
      if (!matches(where)) return { count: 0 };
      apply(data);
      return { count: 1 };
    }),
  };
}

const CODE = '123456';
const freshRow = (over: Partial<Row> = {}): Row => ({
  id: 'otp1',
  codeHash: sha(CODE),
  attempts: 0,
  consumedAt: null,
  expiresAt: new Date(Date.now() + 600_000),
  createdAt: new Date(),
  ...over,
});

const services = [
  {
    name: 'customer reset (UserOtpService)',
    make: (table: ReturnType<typeof fakeTable>) =>
      new UserOtpService({ userOtp: table } as never, {} as never, {} as never),
  },
  {
    name: 'admin reset (AdminOtpService)',
    make: (table: ReturnType<typeof fakeTable>) =>
      new AdminOtpService({ adminOtp: table } as never, {} as never, {} as never),
  },
];

describe.each(services)('C5: $name', ({ make }) => {
  it('accepts the right code once, and burns it', async () => {
    const table = fakeTable(freshRow());
    await expect(make(table).consume('u1', CODE)).resolves.toBeUndefined();
    expect(table.row.consumedAt).not.toBeNull();
  });

  it('refuses the right code after five wrong ones', async () => {
    const table = fakeTable(freshRow());
    const svc = make(table);
    for (let i = 0; i < 5; i++) await expect(svc.consume('u1', '000000')).rejects.toMatchObject({ status: 400 });
    await expect(svc.consume('u1', CODE)).rejects.toMatchObject({ status: 400 });
  });

  it('holds the five-try cap when twenty guesses arrive at the same moment', async () => {
    const table = fakeTable(freshRow());
    const svc = make(table);
    // Nineteen wrong guesses and the right one, sent as the 10th.
    const guesses = Array.from({ length: 20 }, (_, i) => (i === 9 ? CODE : String(100000 + i)));
    const results = await Promise.allSettled(guesses.map((g) => svc.consume('u1', g)));
    expect(results[9].status).toBe('rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(0);
    expect(table.row.attempts).toBeLessThanOrEqual(5);
  });

  it('lets only one of two simultaneous right answers through', async () => {
    const table = fakeTable(freshRow());
    const svc = make(table);
    const results = await Promise.allSettled([svc.consume('u1', CODE), svc.consume('u1', CODE)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('refuses an expired code', async () => {
    const table = fakeTable(freshRow({ expiresAt: new Date(Date.now() - 1000) }));
    await expect(make(table).consume('u1', CODE)).rejects.toMatchObject({
      response: expect.objectContaining({ message: 'That code has expired. Ask for a new one.' }),
    });
  });
});
