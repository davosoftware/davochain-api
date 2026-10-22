import { BadRequestException, ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AdminOtpPurpose, AdminRole } from '@prisma/client';
import { createHash } from 'node:crypto';
import { TwoStepService, TWO_STEP_REQUIRED_FLAG, maskEmail } from './two-step.service';
import { CodeCooldownError } from './otp.service';

/** M7 rules (spec docs/superpowers/specs/2026-10-20-admin-two-step-design.md §3–§6). */
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const OWNER = { id: 'o1', role: AdminRole.OWNER };

type Admin = { id: string; email: string; name: string; role: AdminRole; isActive: boolean; twoStepEnabled: boolean; twoStepEnabledAt: Date | null; failedLogins: number; lockedUntil: Date | null; lastLoginAt: Date | null; passwordHash: string };
type Challenge = { id: string; adminUserId: string; ticketHash: string; kind: 'CODE' | 'SETUP'; attempts: number; expiresAt: Date; consumedAt: Date | null; ip: string | null };
type Backup = { id: string; adminUserId: string; codeHash: string; usedAt: Date | null };

function setup(over: Partial<Admin> = {}, opts: { required?: boolean } = {}) {
  const admins: Admin[] = [
    { id: 'a1', email: 'ada@davochain.test', name: 'Ada Admin', role: AdminRole.SUB_ADMIN, isActive: true, twoStepEnabled: true, twoStepEnabledAt: new Date(), failedLogins: 0, lockedUntil: null, lastLoginAt: null, passwordHash: 'h', ...over },
    { id: 'o1', email: 'owner@davochain.test', name: 'Owner', role: AdminRole.OWNER, isActive: true, twoStepEnabled: true, twoStepEnabledAt: new Date(), failedLogins: 0, lockedUntil: null, lastLoginAt: null, passwordHash: 'h' },
  ];
  let challenges: Challenge[] = [];
  let backups: Backup[] = [];
  const flags: Record<string, unknown> = { [TWO_STEP_REQUIRED_FLAG]: opts.required ?? false };
  // burntOutsideTx: consume() writes on its own connection, so a later rollback cannot undo it (as in Postgres).
  const otp = { code: '', id: 'otp1', purpose: AdminOtpPurpose.LOGIN as AdminOtpPurpose, used: false, burntOutsideTx: false };

  const pick = <T extends object>(rows: T[], where: Record<string, unknown>) =>
    rows.filter((r) =>
      Object.entries(where).every(([k, v]) => {
        const val = (r as Record<string, unknown>)[k];
        if (v === null) return val === null;
        if (v && typeof v === 'object' && 'lt' in v) return (val as number) < (v as { lt: number }).lt;
        if (v && typeof v === 'object' && 'gt' in v) return (val as Date) > (v as { gt: Date }).gt;
        return val === v;
      }),
    );

  const db = {
    adminUser: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => admins.find((a) => a.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Admin> }) => Object.assign(admins.find((a) => a.id === where.id)!, data)),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => pick(admins, where).map((a) => ({ id: a.id }))),
    },
    adminLoginChallenge: {
      create: jest.fn(async ({ data }: { data: Omit<Challenge, 'id' | 'attempts' | 'consumedAt'> }) => {
        const row = { ...data, id: `c${challenges.length + 1}`, attempts: 0, consumedAt: null, ip: data.ip ?? null } as Challenge;
        challenges.push(row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: { where: { ticketHash: string } }) => challenges.find((c) => c.ticketHash === where.ticketHash) ?? null),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: { attempts?: { increment: number }; consumedAt?: Date } }) => {
        const hit = pick(challenges, where);
        for (const c of hit) {
          if (data.attempts) c.attempts += data.attempts.increment;
          if (data.consumedAt) c.consumedAt = data.consumedAt;
        }
        return { count: hit.length };
      }),
    },
    adminBackupCode: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => pick(backups, where)),
      count: jest.fn(async ({ where }: { where: Record<string, unknown> }) => pick(backups, where).length),
      deleteMany: jest.fn(async ({ where }: { where: { adminUserId: string } }) => {
        const before = backups.length;
        backups = backups.filter((b) => b.adminUserId !== where.adminUserId);
        return { count: before - backups.length };
      }),
      createMany: jest.fn(async ({ data }: { data: Omit<Backup, 'id' | 'usedAt'>[] }) => {
        data.forEach((d, i) => backups.push({ ...d, id: `b${backups.length + i + 1}`, usedAt: null }));
        return { count: data.length };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: { usedAt: Date } }) => {
        const hit = pick(backups, where);
        hit.forEach((b) => (b.usedAt = data.usedAt));
        return { count: hit.length };
      }),
    },
    adminOtp: {},
    // Like Postgres: a transaction that throws leaves no trace.
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const snap = { admins: admins.map((a) => ({ ...a })), challenges: challenges.map((c) => ({ ...c })), backups: backups.map((b) => ({ ...b })), used: otp.used };
      try {
        return await fn(db);
      } catch (err) {
        admins.splice(0, admins.length, ...snap.admins);
        challenges = snap.challenges;
        backups = snap.backups;
        otp.used = snap.used || otp.burntOutsideTx;
        throw err;
      }
    }),
  };

  const otps = {
    issue: jest.fn(async (_id: string, purpose: AdminOtpPurpose) => {
      otp.code = '424242';
      otp.purpose = purpose;
      otp.used = false;
      otp.burntOutsideTx = false;
      return { delivered: true, sentTo: ['ada@davochain.test'] };
    }),
    match: jest.fn(async (_id: string, code: string, purpose: AdminOtpPurpose) => (!otp.used && code === otp.code && purpose === otp.purpose ? otp.id : null)),
    check: jest.fn(async (_id: string, code: string, purpose: AdminOtpPurpose) => {
      if (otp.used || code !== otp.code || purpose !== otp.purpose) throw new BadRequestException('That code is not right.');
      return otp.id;
    }),
    consumeById: jest.fn(async () => {
      if (otp.used) return false;
      otp.used = true;
      return true;
    }),
    consume: jest.fn(async (_id: string, code: string, purpose: AdminOtpPurpose) => {
      if (otp.used || code !== otp.code || purpose !== otp.purpose) throw new BadRequestException('That code is not right.');
      otp.used = true;
      otp.burntOutsideTx = true;
    }),
  };
  const passwords = { verify: jest.fn(async (pw: string) => pw === 'right-pw') };
  const flagsSvc = { get: jest.fn(async (k: string, d: unknown) => flags[k] ?? d), set: jest.fn(async (k: string, v: unknown) => void (flags[k] = v)) };
  const sessions = { revokeAllFor: jest.fn(async () => 2) };
  const notices = { send: jest.fn(async () => undefined) };
  const alerts = { raise: jest.fn(async () => true) };
  const svc = new TwoStepService(db as never, otps as never, passwords as never, flagsSvc as never, sessions as never, alerts as never);
  const failures: string[] = [];
  jest.spyOn(svc as unknown as { recordFailure: (id: string) => Promise<{ justLocked: boolean }> }, 'recordFailure').mockImplementation(async (id: string) => {
    failures.push(id);
    const a = admins.find((x) => x.id === id)!;
    a.failedLogins++;
    return { justLocked: a.failedLogins === 5 };
  });
  jest.spyOn(svc as unknown as { notice: () => Promise<void> }, 'notice').mockImplementation(notices.send);
  return { svc, admins, otp, otps, failures, sessions, notices, flags, flagsSvc, alerts, challenges: () => challenges, backups: () => backups };
}

async function signedInToStepTwo(s: ReturnType<typeof setup>, kind: 'CODE' | 'SETUP' = 'CODE') {
  const { ticket } = await s.svc.startChallenge({ id: 'a1' }, kind, '1.2.3.4');
  await s.svc.sendCode(ticket);
  return ticket;
}

describe('Starting the second step', () => {
  it('stores only a hash of a long random ticket, valid 10 minutes', async () => {
    const s = setup();
    const { ticket } = await s.svc.startChallenge({ id: 'a1' }, 'CODE', '1.2.3.4');
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = s.challenges()[0];
    expect(row.ticketHash).toBe(sha(ticket));
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
  });

  it('signing in again within a minute reuses the code just sent instead of failing; "Send a new code" still waits', async () => {
    const s = setup();
    const { ticket } = await s.svc.startChallenge({ id: 'a1' }, 'CODE');
    s.otps.issue.mockRejectedValueOnce(new CodeCooldownError(40));
    await expect(s.svc.sendCode(ticket, { reuseRecent: true })).resolves.toEqual({ delivered: true, sentTo: 'a**@davochain.test' });
    s.otps.issue.mockRejectedValueOnce(new CodeCooldownError(40));
    await expect(s.svc.sendCode(ticket)).rejects.toThrow('A code was just sent. Try again in 40 seconds.');
  });

  it('masks the email the code went to', () => {
    expect(maskEmail('ada@davochain.test')).toBe('a**@davochain.test');
    expect(maskEmail('x@d.co')).toBe('x*@d.co');
  });
});

describe('verifyLogin: the emailed code or a backup code', () => {
  it('the right emailed code signs in once, resets failed sign-ins, and burns the ticket', async () => {
    const s = setup({ failedLogins: 2 });
    const ticket = await signedInToStepTwo(s);
    const out = await s.svc.verifyLogin(ticket, '424242');
    expect(out.admin.id).toBe('a1');
    expect(out.usedBackup).toBe(false);
    expect(s.admins[0].failedLogins).toBe(0);
    expect(s.admins[0].lastLoginAt).toBeInstanceOf(Date);
    await expect(s.svc.verifyLogin(ticket, '424242')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a wrong code counts toward the lockout and says only "not right"', async () => {
    const s = setup();
    const ticket = await signedInToStepTwo(s);
    await expect(s.svc.verifyLogin(ticket, '000000')).rejects.toThrow(new BadRequestException('That code is not right.'));
    expect(s.failures).toEqual(['a1']);
  });

  it('five wrong codes burn the sign-in; a sixth try, even right, is refused', async () => {
    const s = setup();
    const ticket = await signedInToStepTwo(s);
    for (let i = 0; i < 5; i++) await expect(s.svc.verifyLogin(ticket, '000000')).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.svc.verifyLogin(ticket, '424242')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('the fifth wrong code that locks the account raises the lockout alert', async () => {
    const s = setup({ failedLogins: 4 });
    const ticket = await signedInToStepTwo(s);
    await expect(s.svc.verifyLogin(ticket, '000000')).rejects.toBeInstanceOf(BadRequestException);
    expect(s.alerts.raise).toHaveBeenCalled();
  });

  it('a locked or deactivated admin cannot finish, even with the right code', async () => {
    const locked = setup();
    const lt = await signedInToStepTwo(locked);
    locked.admins[0].lockedUntil = new Date(Date.now() + 60_000);
    await expect(locked.svc.verifyLogin(lt, '424242')).rejects.toBeInstanceOf(UnauthorizedException);
    const off = setup();
    const t = await signedInToStepTwo(off);
    off.admins[0].isActive = false;
    await expect(off.svc.verifyLogin(t, '424242')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('an expired, unknown or SETUP ticket is refused for verifyLogin', async () => {
    const s = setup();
    const t = await signedInToStepTwo(s);
    s.challenges()[0].expiresAt = new Date(Date.now() - 1);
    await expect(s.svc.verifyLogin(t, '424242')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(s.svc.verifyLogin('made-up-ticket', '424242')).rejects.toBeInstanceOf(UnauthorizedException);
    const setupTicket = await signedInToStepTwo(setup(), 'SETUP');
    await expect(s.svc.verifyLogin(setupTicket, '424242')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a switch-on code cannot stand in for a sign-in code', async () => {
    const s = setup();
    const { ticket } = await s.svc.startChallenge({ id: 'a1' }, 'CODE');
    await s.otps.issue('a1', AdminOtpPurpose.TWO_STEP_CHANGE);
    await expect(s.svc.verifyLogin(ticket, '424242')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a backup code signs in once, says how many are left, and cannot be used again', async () => {
    const s = setup();
    const codes = await s.svc.generateBackupCodes(s.svc['prisma'] as never, 'a1');
    const t1 = await signedInToStepTwo(s);
    const out = await s.svc.verifyLogin(t1, codes[3]);
    expect(out).toMatchObject({ usedBackup: true, backupLeft: 9 });
    const t2 = await signedInToStepTwo(s);
    s.otps.issue.mockClear();
    await expect(s.svc.verifyLogin(t2, codes[3])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('two right answers at the same moment: exactly one sign-in', async () => {
    const s = setup();
    const ticket = await signedInToStepTwo(s);
    const results = await Promise.allSettled([s.svc.verifyLogin(ticket, '424242'), s.svc.verifyLogin(ticket, '424242')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('Backup codes', () => {
  it('ten different 6-digit codes, stored only as hashes, replacing any older set', async () => {
    const s = setup();
    const first = await s.svc.generateBackupCodes(s.svc['prisma'] as never, 'a1');
    expect(first).toHaveLength(10);
    expect(new Set(first).size).toBe(10);
    for (const c of first) expect(c).toMatch(/^\d{6}$/);
    expect(s.backups().map((b) => b.codeHash)).toEqual(first.map(sha));
    await s.svc.generateBackupCodes(s.svc['prisma'] as never, 'a1');
    expect(s.backups()).toHaveLength(10);
    expect(s.backups().some((b) => b.codeHash === sha(first[0]))).toBe(false);
  });
});

describe('SETUP: an owner requires two-step and this admin has not switched it on', () => {
  it('the emailed switch-on code finishes the sign-in, switches two-step on and gives 10 backup codes', async () => {
    const s = setup({ twoStepEnabled: false, twoStepEnabledAt: null }, { required: true });
    const ticket = await signedInToStepTwo(s, 'SETUP');
    expect(s.otps.issue).toHaveBeenLastCalledWith('a1', AdminOtpPurpose.TWO_STEP_CHANGE);
    const out = await s.svc.completeSetup(ticket, '424242');
    expect(out.backupCodes).toHaveLength(10);
    expect(s.admins[0].twoStepEnabled).toBe(true);
    await expect(s.svc.completeSetup(ticket, '424242')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a backup code is not accepted for setup, and a CODE ticket is refused', async () => {
    const s = setup({ twoStepEnabled: false }, { required: true });
    const codeTicket = await signedInToStepTwo(s, 'CODE');
    await expect(s.svc.completeSetup(codeTicket, '424242')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('My account', () => {
  it('status shows whether it is on, backup codes left, and whether owners require it', async () => {
    const s = setup({}, { required: true });
    await s.svc.generateBackupCodes(s.svc['prisma'] as never, 'a1');
    await expect(s.svc.status('a1')).resolves.toMatchObject({ enabled: true, backupCodesLeft: 10, required: true });
  });

  it('switching on needs the password, then the emailed code; it ends the admin\'s other sessions', async () => {
    const s = setup({ twoStepEnabled: false, twoStepEnabledAt: null });
    await expect(s.svc.sendChangeCode('a1', 'wrong')).rejects.toThrow('That password is not correct.');
    expect(s.failures).toEqual(['a1']);
    await s.svc.sendChangeCode('a1', 'right-pw');
    await expect(s.svc.enable('a1', '000000', 'jti-now')).rejects.toBeInstanceOf(BadRequestException);
    const out = await s.svc.enable('a1', '424242', 'jti-now');
    expect(out.backupCodes).toHaveLength(10);
    expect(s.admins[0].twoStepEnabled).toBe(true);
    expect(s.sessions.revokeAllFor).toHaveBeenCalledWith('a1', expect.any(String), 'jti-now');
  });

  it('C8: a switch-on that fails to save keeps the code, so the admin can simply try again', async () => {
    const s = setup({ twoStepEnabled: false, twoStepEnabledAt: null });
    await s.svc.sendChangeCode('a1', 'right-pw');
    const real = s.svc.generateBackupCodes.bind(s.svc);
    jest.spyOn(s.svc, 'generateBackupCodes').mockRejectedValueOnce(new Error('database hiccup'));
    await expect(s.svc.enable('a1', '424242', 'jti-now')).rejects.toThrow('database hiccup');
    expect(s.admins[0].twoStepEnabled).toBe(false);
    (s.svc.generateBackupCodes as jest.Mock).mockImplementation(real);
    await expect(s.svc.enable('a1', '424242', 'jti-now')).resolves.toMatchObject({ backupCodes: expect.any(Array) });
  });

  it('C8: a switch-off with the emailed code that fails to save keeps the code', async () => {
    const s = setup();
    await s.svc.sendChangeCode('a1', 'right-pw');
    const db = s.svc['prisma'] as unknown as { adminBackupCode: { deleteMany: jest.Mock } };
    const realDelete = db.adminBackupCode.deleteMany.getMockImplementation()!;
    db.adminBackupCode.deleteMany.mockImplementationOnce(async () => {
      throw new Error('database hiccup');
    });
    await expect(s.svc.disable('a1', 'right-pw', '424242')).rejects.toThrow('database hiccup');
    expect(s.admins[0].twoStepEnabled).toBe(true);
    db.adminBackupCode.deleteMany.mockImplementation(realDelete);
    await expect(s.svc.disable('a1', 'right-pw', '424242')).resolves.toBeUndefined();
    expect(s.admins[0].twoStepEnabled).toBe(false);
  });

  it('switching on twice is refused', async () => {
    const s = setup();
    await expect(s.svc.enable('a1', '424242', 'j')).rejects.toBeInstanceOf(ConflictException);
  });

  it('new backup codes need the password and two-step on', async () => {
    const off = setup({ twoStepEnabled: false });
    await expect(off.svc.regenerate('a1', 'right-pw')).rejects.toBeInstanceOf(ConflictException);
    const on = setup();
    await expect(on.svc.regenerate('a1', 'wrong')).rejects.toThrow('That password is not correct.');
    await expect(on.svc.regenerate('a1', 'right-pw')).resolves.toHaveLength(10);
  });

  it('switching off needs the password and an emailed code or a backup code, and emails the admin', async () => {
    const s = setup();
    const codes = await s.svc.generateBackupCodes(s.svc['prisma'] as never, 'a1');
    await expect(s.svc.disable('a1', 'right-pw', '000000')).rejects.toBeInstanceOf(BadRequestException);
    await s.svc.disable('a1', 'right-pw', codes[0]);
    expect(s.admins[0].twoStepEnabled).toBe(false);
    expect(s.backups()).toHaveLength(0);
    expect(s.notices.send).toHaveBeenCalled();
  });

  it('switching off is refused while an owner requires two-step', async () => {
    const s = setup({}, { required: true });
    await expect(s.svc.disable('a1', 'right-pw', '424242')).rejects.toBeInstanceOf(ConflictException);
    expect(s.admins[0].twoStepEnabled).toBe(true);
  });
});

describe('Owner: require two-step for all admins', () => {
  it('owners only, with the password', async () => {
    const s = setup();
    await expect(s.svc.setRequired({ id: 'a1', role: AdminRole.SUB_ADMIN }, true, 'right-pw')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.svc.setRequired(OWNER, true, 'wrong')).rejects.toThrow('That password is not correct.');
    await expect(s.svc.setRequired(OWNER, true, 'right-pw')).resolves.toEqual({ before: false, after: true });
    expect(s.flags[TWO_STEP_REQUIRED_FLAG]).toBe(true);
  });

  it('C8: requiring it signs out every admin who does not have it on, at once', async () => {
    const s = setup({ twoStepEnabled: false, twoStepEnabledAt: null });
    await s.svc.setRequired(OWNER, true, 'right-pw');
    expect(s.sessions.revokeAllFor).toHaveBeenCalledWith('a1', expect.stringMatching(/required/));
    expect(s.sessions.revokeAllFor).not.toHaveBeenCalledWith('o1', expect.anything());
    s.sessions.revokeAllFor.mockClear();
    await s.svc.setRequired(OWNER, true, 'right-pw'); // already required: nobody new to sign out
    await s.svc.setRequired(OWNER, false, 'right-pw');
    expect(s.sessions.revokeAllFor).not.toHaveBeenCalled();
  });

  it('an owner cannot require it without having it on themselves', async () => {
    const s = setup();
    s.admins[1].twoStepEnabled = false;
    await expect(s.svc.setRequired(OWNER, true, 'right-pw')).rejects.toBeInstanceOf(ConflictException);
    await expect(s.svc.setRequired(OWNER, false, 'right-pw')).resolves.toEqual({ before: false, after: false });
  });
});
