import { BadRequestException } from '@nestjs/common';
import { UserOtpPurpose } from '@prisma/client';
import { UserOtpService } from './user-otp.service';
import { AuthService } from './auth.service';

/**
 * H9 "verify before money" (plan 2026-10-22 Task 4): a six-digit code proves a
 * new customer owns their email. Same rules as the password-reset code:
 * 10 minutes, 5 tries, single use, one per minute.
 */
type Otp = { id: string; userId: string; purpose: UserOtpPurpose; codeHash: string; expiresAt: Date; consumedAt: Date | null; attempts: number; createdAt: Date };

function setup() {
  const users = [{ id: 'u1', email: 'ada@example.com', firstName: 'Ada', status: 'ACTIVE', emailVerifiedAt: null as Date | null }];
  const otps: Otp[] = [];
  const where = (o: Otp, w: Record<string, unknown>) =>
    Object.entries(w).every(([k, v]) => {
      const val = (o as Record<string, unknown>)[k];
      if (v === null) return val === null;
      if (v && typeof v === 'object' && 'lt' in v) return (val as number) < (v as { lt: number }).lt;
      if (v && typeof v === 'object' && 'gt' in v) return (val as Date) > (v as { gt: Date }).gt;
      return val === v;
    });
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where: w }: { where: { id?: string; email?: string } }) => users.find((u) => (w.id ? u.id === w.id : u.email === w.email)) ?? null),
      update: jest.fn(async ({ where: w, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(users.find((u) => u.id === w.id)!, data)),
    },
    userOtp: {
      findFirst: jest.fn(async ({ where: w }: { where: Record<string, unknown> }) => [...otps].reverse().find((o) => where(o, w)) ?? null),
      findUnique: jest.fn(async ({ where: w }: { where: { id: string } }) => otps.find((o) => o.id === w.id) ?? null),
      create: jest.fn(async ({ data }: { data: Omit<Otp, 'id' | 'consumedAt' | 'attempts' | 'createdAt'> }) => {
        const row = { ...data, id: `o${otps.length + 1}`, consumedAt: null, attempts: 0, createdAt: new Date() };
        otps.push(row);
        return row;
      }),
      update: jest.fn(async ({ where: w, data }: { where: { id: string }; data: Partial<Otp> }) => Object.assign(otps.find((o) => o.id === w.id)!, data)),
      updateMany: jest.fn(async ({ where: w, data }: { where: Record<string, unknown>; data: { consumedAt?: Date; attempts?: { increment: number } } }) => {
        const hit = otps.filter((o) => where(o, w));
        for (const o of hit) {
          if (data.consumedAt) o.consumedAt = data.consumedAt;
          if (data.attempts) o.attempts += data.attempts.increment;
        }
        return { count: hit.length };
      }),
    },
  };
  const sent: Array<{ template: string; code: string }> = [];
  const templates = {
    render: jest.fn(async (key: string, vars: { code: string }) => {
      sent.push({ template: key, code: vars.code });
      return { subject: 's', text: 't', html: 'h' };
    }),
  };
  const mail = { send: jest.fn(async () => true) };
  const otpSvc = new UserOtpService(prisma as never, mail as never, templates as never);
  const auth = Object.create(AuthService.prototype) as AuthService;
  Object.assign(auth, { prisma, otps: otpSvc, log: { warn: jest.fn(), error: jest.fn(), log: jest.fn() } });
  const lastCode = () => sent[sent.length - 1].code;
  return { users, otps, sent, mail, otpSvc, auth, lastCode };
}

describe('Email verification codes (H9)', () => {
  it('a code is emailed with the email-verify template; the right code confirms the email, once', async () => {
    const s = setup();
    await expect(s.auth.sendEmailCode('u1')).resolves.toEqual({ sent: true });
    expect(s.sent[0].template).toBe('user.email_verify');
    expect(s.otps[0].purpose).toBe(UserOtpPurpose.EMAIL_VERIFY);
    const code = s.lastCode();
    await expect(s.auth.verifyEmail('u1', code)).resolves.toEqual({ verified: true });
    expect(s.users[0].emailVerifiedAt).toBeInstanceOf(Date);
    await expect(s.auth.verifyEmail('u1', code)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('5 tries, then the code is burnt (Review Focus 5)', async () => {
    const s = setup();
    await s.auth.sendEmailCode('u1');
    const right = s.lastCode();
    const wrong = right === '000000' ? '111111' : '000000';
    await expect(s.auth.verifyEmail('u1', wrong)).rejects.toThrow('That code is not right. 4 tries left.');
    for (let i = 0; i < 3; i++) await s.auth.verifyEmail('u1', wrong).catch(() => undefined);
    await expect(s.auth.verifyEmail('u1', wrong)).rejects.toThrow('Too many wrong codes. Ask for a new one.');
    await expect(s.auth.verifyEmail('u1', right)).rejects.toBeInstanceOf(BadRequestException);
    expect(s.users[0].emailVerifiedAt).toBeNull();
  });

  it('an expired code is refused (Review Focus 5)', async () => {
    const s = setup();
    await s.auth.sendEmailCode('u1');
    s.otps[0].expiresAt = new Date(Date.now() - 1000);
    await expect(s.auth.verifyEmail('u1', s.lastCode())).rejects.toThrow('That code has expired. Ask for a new one.');
  });

  it('an email code cannot reset a password, and a reset code cannot confirm an email', async () => {
    const s = setup();
    await s.auth.sendEmailCode('u1');
    await expect(s.otpSvc.consume('u1', s.lastCode(), UserOtpPurpose.PASSWORD_RESET)).rejects.toBeInstanceOf(BadRequestException);
    await s.otpSvc.request('ada@example.com');
    expect(s.sent[1].template).toBe('user.password_reset');
    await expect(s.auth.verifyEmail('u1', s.lastCode())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('one code a minute: asking again at once sends nothing new', async () => {
    const s = setup();
    await s.auth.sendEmailCode('u1');
    await s.auth.sendEmailCode('u1');
    expect(s.sent).toHaveLength(1);
  });

  it('already confirmed: nothing is sent', async () => {
    const s = setup();
    s.users[0].emailVerifiedAt = new Date();
    await expect(s.auth.sendEmailCode('u1')).resolves.toEqual({ sent: true, alreadyVerified: true });
    expect(s.sent).toHaveLength(0);
  });

  it('a mail failure never fails: the code can be asked for again later', async () => {
    const s = setup();
    s.mail.send.mockResolvedValueOnce(false);
    await expect(s.auth.sendEmailCode('u1')).resolves.toEqual({ sent: true });
  });
});
