import { AdminOtpPurpose, AdminRole } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AdminOtpService } from './otp.service';

/**
 * M7: admin one-time codes have purposes, and a code is only good for the
 * purpose it was issued for. The sign-in and two-step codes go to the admin
 * alone (a password reset still copies the owners).
 */
type Row = { id: string; adminUserId: string; purpose: AdminOtpPurpose; codeHash: string; sentTo: string[]; attempts: number; consumedAt: Date | null; expiresAt: Date; createdAt: Date };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function setup(role: AdminRole = AdminRole.SUB_ADMIN) {
  const rows: Row[] = [];
  const sent: Array<{ to: string; templateKey: string }> = [];
  let lastCode = '';
  const open = (where: { adminUserId?: string; purpose?: AdminOtpPurpose; consumedAt?: null; id?: string }) =>
    rows.filter(
      (r) =>
        (where.id === undefined || r.id === where.id) &&
        (where.adminUserId === undefined || r.adminUserId === where.adminUserId) &&
        (where.purpose === undefined || r.purpose === where.purpose) &&
        (!('consumedAt' in where) || r.consumedAt === null),
    );
  const prisma = {
    adminUser: {
      findUnique: jest.fn(async () => ({ id: 'a1', email: 'sub@d.test', name: 'Sub Admin', role, isActive: true })),
      findMany: jest.fn(async () => [{ email: 'owner@d.test' }]),
    },
    adminOtp: {
      findFirst: jest.fn(async ({ where }: { where: never }) => open(where).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
      create: jest.fn(async ({ data }: { data: Omit<Row, 'id' | 'attempts' | 'consumedAt' | 'createdAt'> }) => {
        const row = { ...data, id: `o${rows.length + 1}`, attempts: 0, consumedAt: null, createdAt: new Date() } as Row;
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => Object.assign(rows.find((r) => r.id === where.id)!, data)),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: { consumedAt?: Date; attempts?: { increment: number } } }) => {
        const hit = open(where as never).filter((r) => {
          const w = where as { attempts?: { lt: number }; expiresAt?: { gt: Date } };
          return (!w.attempts || r.attempts < w.attempts.lt) && (!w.expiresAt || r.expiresAt > w.expiresAt.gt);
        });
        for (const r of hit) {
          if (data.consumedAt) r.consumedAt = data.consumedAt;
          if (data.attempts) r.attempts += data.attempts.increment;
        }
        return { count: hit.length };
      }),
    },
  };
  const templates = {
    render: jest.fn(async (_key: string, vars: { code: string }) => {
      lastCode = vars.code;
      return { subject: 's', text: vars.code, html: vars.code };
    }),
  };
  const mail = { send: jest.fn(async (m: { to: string; templateKey: string }) => (sent.push(m), true)) };
  const svc = new AdminOtpService(prisma as never, mail as never, templates as never);
  return { svc, rows, sent, code: () => lastCode, prisma };
}

describe('Admin one-time codes by purpose (M7)', () => {
  it('a sign-in code goes to the admin only, with the sign-in template', async () => {
    const { svc, sent } = setup(AdminRole.SUB_ADMIN);
    const out = await svc.issue('a1', AdminOtpPurpose.LOGIN);
    expect(out).toEqual({ delivered: true, sentTo: ['sub@d.test'] });
    expect(sent.map((m) => [m.to, m.templateKey])).toEqual([['sub@d.test', 'admin.login_code']]);
  });

  it('a two-step change code uses its own template', async () => {
    const { svc, sent } = setup();
    await svc.issue('a1', AdminOtpPurpose.TWO_STEP_CHANGE);
    expect(sent[0].templateKey).toBe('admin.two_step_code');
  });

  it('a password reset still copies the owners (unchanged)', async () => {
    const { svc, sent } = setup(AdminRole.SUB_ADMIN);
    await svc.requestPasswordReset('a1');
    expect(sent.map((m) => m.to).sort()).toEqual(['owner@d.test', 'sub@d.test']);
  });

  it('a code is only good for the purpose it was issued for', async () => {
    const { svc, code } = setup();
    await svc.issue('a1', AdminOtpPurpose.LOGIN);
    const loginCode = code();
    await expect(svc.consume('a1', loginCode, AdminOtpPurpose.TWO_STEP_CHANGE)).rejects.toThrow('That code is not right.');
    await expect(svc.consume('a1', loginCode, AdminOtpPurpose.PASSWORD_RESET)).rejects.toThrow('That code is not right.');
    await expect(svc.consume('a1', loginCode, AdminOtpPurpose.LOGIN)).resolves.toBeUndefined();
  });

  it('each purpose has its own 60-second cooldown', async () => {
    const { svc } = setup();
    await svc.issue('a1', AdminOtpPurpose.LOGIN);
    await expect(svc.issue('a1', AdminOtpPurpose.LOGIN)).rejects.toThrow(/Try again in \d+ seconds/);
    await expect(svc.issue('a1', AdminOtpPurpose.TWO_STEP_CHANGE)).resolves.toMatchObject({ delivered: true });
  });

  it('a new code cancels the older one of the same purpose', async () => {
    const { svc, rows, code } = setup();
    await svc.issue('a1', AdminOtpPurpose.LOGIN);
    const first = code();
    rows[0].createdAt = new Date(Date.now() - 61_000);
    await svc.issue('a1', AdminOtpPurpose.LOGIN);
    if (first !== code()) await expect(svc.consume('a1', first, AdminOtpPurpose.LOGIN)).rejects.toThrow('That code is not right.');
    expect(rows[0].consumedAt).not.toBeNull();
  });

  it('match() finds the open code without using up an attempt; consumeById() then burns it once', async () => {
    const { svc, rows, code } = setup();
    await svc.issue('a1', AdminOtpPurpose.LOGIN);
    expect(await svc.match('a1', '000000' === code() ? '111111' : '000000', AdminOtpPurpose.LOGIN)).toBeNull();
    const id = await svc.match('a1', code(), AdminOtpPurpose.LOGIN);
    expect(id).toBe(rows[0].id);
    expect(rows[0].attempts).toBe(0);
    expect(await svc.consumeById(svc['prisma'] as never, id!)).toBe(true);
    expect(await svc.consumeById(svc['prisma'] as never, id!)).toBe(false);
    expect(sha(code())).toBe(rows[0].codeHash);
  });

  it('an expired code never matches', async () => {
    const { svc, rows, code } = setup();
    await svc.issue('a1', AdminOtpPurpose.LOGIN);
    rows[0].expiresAt = new Date(Date.now() - 1);
    expect(await svc.match('a1', code(), AdminOtpPurpose.LOGIN)).toBeNull();
  });
});
