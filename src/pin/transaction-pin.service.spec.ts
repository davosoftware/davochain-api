import { UserOtpPurpose } from '@prisma/client';
import { TransactionPinService } from './transaction-pin.service';

/** A user row and just enough of Prisma's where-clauses to drive the service. */
function fakeDb(start: Record<string, unknown> = {}) {
  const user: Record<string, any> = {
    id: 'u1',
    email: 'ada@example.com',
    firstName: 'Ada',
    lastName: 'Okafor',
    passwordHash: 'pw:Right-password-1',
    lockedUntil: null,
    transactionPinHash: null,
    transactionPinSetAt: null,
    pinFailedCount: 0,
    pinLockedUntil: null,
    credentialsChangedAt: null,
    ...start,
  };
  const matches = (where: any): boolean => {
    if (where.transactionPinHash === null && user.transactionPinHash !== null) return false;
    if (where.pinFailedCount?.lt !== undefined && !(user.pinFailedCount < where.pinFailedCount.lt)) return false;
    if (where.pinFailedCount?.gte !== undefined && !(user.pinFailedCount >= where.pinFailedCount.gte)) return false;
    if (where.OR) {
      const lte = where.OR[1].pinLockedUntil.lte as Date;
      if (!(user.pinLockedUntil === null || user.pinLockedUntil <= lte)) return false;
    }
    return true;
  };
  const apply = (data: any) => {
    for (const [k, v] of Object.entries(data)) {
      user[k] = v && typeof v === 'object' && 'increment' in (v as any) ? user[k] + (v as any).increment : v;
    }
  };
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({ ...user })),
      update: jest.fn(async ({ data }: any) => apply(data)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!matches(where)) return { count: 0 };
        apply(data);
        return { count: 1 };
      }),
    },
    $transaction: jest.fn(),
  };
  return { user, prisma };
}

const passwords = {
  hash: jest.fn(async (s: string) => `pw:${s}`),
  verify: jest.fn(async (s: string, stored: string) => stored === `pw:${s}`),
};

jest.mock('../auth/failed-logins', () => ({ recordFailedLogin: jest.fn(async () => ({})) }));

function build(start?: Record<string, unknown>) {
  const { user, prisma } = fakeDb(start);
  const otps = { requestForUser: jest.fn(async () => undefined), consume: jest.fn(async () => undefined) };
  const mail = { send: jest.fn(async () => undefined) };
  const svc = new TransactionPinService(prisma as any, passwords as any, otps as any, mail as any);
  return { svc, user, otps, mail };
}

const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e: any) {
    return { status: e.getStatus(), ...(e.getResponse() as object) } as any;
  }
  throw new Error('expected an error');
};

describe('TransactionPinService', () => {
  it('creates a PIN with the right password and emails a security notice', async () => {
    const { svc, user, mail } = build();
    const s = await svc.create('u1', 'Right-password-1', '4826');
    expect(s.isSet).toBe(true);
    expect(user.transactionPinHash).toBe('pw:4826');
    expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ key: 'user.pin_changed' }));
  });

  it('refuses to create with a wrong password (403 PASSWORD_WRONG, never 401)', async () => {
    const { svc, user } = build();
    const e = await err(svc.create('u1', 'nope', '4826'));
    expect(e).toMatchObject({ status: 403, code: 'PASSWORD_WRONG' });
    expect(user.transactionPinHash).toBeNull();
  });

  it('refuses an easy PIN and a second create', async () => {
    const { svc } = build();
    expect(await err(svc.create('u1', 'Right-password-1', '1234'))).toMatchObject({ status: 400, code: 'PIN_WEAK' });
    await svc.create('u1', 'Right-password-1', '4826');
    expect(await err(svc.create('u1', 'Right-password-1', '7391'))).toMatchObject({ status: 409, code: 'PIN_ALREADY_SET' });
  });

  it('verify: PIN_NOT_SET, then PIN_REQUIRED, then passes with the right PIN', async () => {
    const { svc } = build();
    expect(await err(svc.verify('u1', '4826'))).toMatchObject({ status: 403, code: 'PIN_NOT_SET' });
    await svc.create('u1', 'Right-password-1', '4826');
    expect(await err(svc.verify('u1', undefined))).toMatchObject({ status: 403, code: 'PIN_REQUIRED' });
    await expect(svc.verify('u1', '4826')).resolves.toBeUndefined();
  });

  it('counts wrong PINs down, and a right one resets the count', async () => {
    const { svc, user } = build({ transactionPinHash: 'pw:4826' });
    expect(await err(svc.verify('u1', '0000'))).toMatchObject({ code: 'PIN_WRONG', triesLeft: 4 });
    expect(await err(svc.verify('u1', '0000'))).toMatchObject({ code: 'PIN_WRONG', triesLeft: 3 });
    await svc.verify('u1', '4826');
    expect(user.pinFailedCount).toBe(0);
  });

  it('locks for 30 minutes on the fifth wrong PIN, emails once, and refuses even the right PIN while locked', async () => {
    const { svc, user, mail } = build({ transactionPinHash: 'pw:4826' });
    const now = new Date('2026-10-29T10:00:00Z');
    for (let i = 0; i < 4; i++) await err(svc.verify('u1', '0000', now));
    const e = await err(svc.verify('u1', '0000', now));
    expect(e).toMatchObject({ code: 'PIN_LOCKED', until: '2026-10-29T10:30:00.000Z' });
    expect(user.pinLockedUntil).toEqual(new Date('2026-10-29T10:30:00Z'));
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ key: 'user.pin_locked' }));
    expect(await err(svc.verify('u1', '4826', new Date('2026-10-29T10:10:00Z')))).toMatchObject({ code: 'PIN_LOCKED' });
    // After the lock ends, the right PIN works again.
    await expect(svc.verify('u1', '4826', new Date('2026-10-29T10:31:00Z'))).resolves.toBeUndefined();
  });

  it('change: needs the right old PIN and a different new one', async () => {
    const { svc, user } = build({ transactionPinHash: 'pw:4826' });
    expect(await err(svc.change('u1', '0000', '7391'))).toMatchObject({ code: 'PIN_WRONG' });
    expect(await err(svc.change('u1', '4826', '4826'))).toMatchObject({ code: 'PIN_SAME' });
    await svc.change('u1', '4826', '7391');
    expect(user.transactionPinHash).toBe('pw:7391');
  });

  it('reset: password sends a code; the code sets a new PIN, unlocks, and starts the withdrawal wait', async () => {
    const { svc, user, otps } = build({ transactionPinHash: 'pw:4826', pinLockedUntil: new Date(Date.now() + 600_000) });
    await svc.requestReset('u1', 'Right-password-1');
    expect(otps.requestForUser).toHaveBeenCalledWith('u1', UserOtpPurpose.PIN_RESET);
    const s = await svc.reset('u1', '123456', '7391');
    expect(otps.consume).toHaveBeenCalledWith('u1', '123456', UserOtpPurpose.PIN_RESET);
    expect(user.transactionPinHash).toBe('pw:7391');
    expect(s.lockedUntil).toBeNull();
    expect(user.credentialsChangedAt).toBeInstanceOf(Date);
  });

  it('reset: no code is sent for a wrong password', async () => {
    const { svc, otps } = build({ transactionPinHash: 'pw:4826' });
    expect(await err(svc.requestReset('u1', 'nope'))).toMatchObject({ code: 'PASSWORD_WRONG' });
    expect(otps.requestForUser).not.toHaveBeenCalled();
  });
});
