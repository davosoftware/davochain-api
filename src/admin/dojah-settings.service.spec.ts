import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { DojahSettingsService } from './dojah-settings.service';
import { DOJAH_SETTINGS_FLAG } from '../dojah/dojah.config';
import { dojahThresholds } from '../dojah/threshold';

const OWNER = { id: 'owner-1', role: AdminRole.OWNER };
const SUB = { id: 'sub-1', role: AdminRole.SUB_ADMIN };

function build(o: { stored?: Record<string, unknown>; ready?: boolean; failing?: string[]; passwordOk?: boolean } = {}) {
  let stored: Record<string, unknown> | undefined = o.stored;
  const upserts: Array<Record<string, unknown>> = [];
  const prisma = {
    systemFlag: {
      findUnique: jest.fn(async () => (stored ? { key: DOJAH_SETTINGS_FLAG, value: stored } : null)),
      upsert: jest.fn(async ({ create, update }: { create: { value: Record<string, unknown> }; update: { value: Record<string, unknown> } }) => {
        upserts.push(update.value);
        stored = update.value ?? create.value;
      }),
    },
    adminUser: { findUnique: jest.fn(async () => ({ passwordHash: 'h' })) },
  };
  // Server defaults (api/.env): hard stop 8,000, warning 20,000, tries 3 a day and 10 in total.
  const cfg = {
    minBalance: 8000,
    lowBalanceWarn: 20000,
    dailyAttempts: 3,
    totalAttempts: 10,
    effective: jest.fn(async () => ({ minBalance: 8000, lowBalanceWarn: 20000, dailyAttempts: 3, totalAttempts: 10, basicEnabled: false, source: {} })),
  };
  const readiness = {
    report: jest.fn(async (_refresh?: boolean) => ({
      ready: o.ready ?? true,
      checks: (o.failing ?? []).map((key) => ({ key, ok: false, required: true, detail: `${key} failing` })),
      observed: { peakHour7d: 12, peakDay7d: 90 },
    })),
    invalidate: jest.fn(),
  };
  const passwords = { verify: jest.fn(async () => o.passwordOk ?? true) };
  const svc = new DojahSettingsService(prisma as never, cfg as never, readiness as never, passwords as never);
  return { svc, upserts, readiness, current: () => stored };
}

describe('Dojah settings saved from the screen', () => {
  it('saves only what was sent; null resets a field to the server default; clears the readiness cache', async () => {
    const { svc, current, readiness } = build({ stored: { minBalance: 9000, dailyAttempts: 5 } });
    await svc.saveSettings('admin-1', { lowBalanceWarn: 25000, dailyAttempts: null });
    expect(current()).toEqual({ minBalance: 9000, lowBalanceWarn: 25000 });
    expect(readiness.invalidate).toHaveBeenCalled();
  });

  it.each([
    [{ minBalance: -1 }, 'Enter a whole naira amount, 0 or more.'],
    [{ minBalance: 10.5 }, 'Enter a whole naira amount, 0 or more.'],
    [{ minBalance: 30000, lowBalanceWarn: 20000 }, 'The warning level must be higher than the hard stop.'],
    [{ dailyAttempts: 0 }, "Tries must be whole numbers from 1 to 20, and the daily number can't be more than the total."],
    [{ dailyAttempts: 21 }, "Tries must be whole numbers from 1 to 20, and the daily number can't be more than the total."],
    [{ dailyAttempts: 12, totalAttempts: 10 }, "Tries must be whole numbers from 1 to 20, and the daily number can't be more than the total."],
  ])('refuses %o, saving nothing', async (patch, message) => {
    const { svc, upserts } = build();
    await expect(svc.saveSettings('admin-1', patch as never)).rejects.toThrow(new BadRequestException(message));
    expect(upserts).toHaveLength(0);
  });

  it('checks the warning against the hard stop that will apply (one may be the server default)', async () => {
    const { svc } = build();
    // Server hard stop is 8,000: a warning of 5,000 alone is below it.
    await expect(svc.saveSettings('admin-1', { lowBalanceWarn: 5000 })).rejects.toThrow(new BadRequestException('The warning level must be higher than the hard stop.'));
  });
});

describe('The Basic verification switch', () => {
  it('owners only', async () => {
    await expect(build().svc.setBasicSwitch(SUB, { enabled: true, password: 'pw' })).rejects.toThrow(
      new ForbiddenException('Only an owner can switch Basic verification on or off'),
    );
  });

  it('needs the password', async () => {
    await expect(build({ passwordOk: false }).svc.setBasicSwitch(OWNER, { enabled: true, password: 'x' })).rejects.toThrow(
      new BadRequestException('That password is not correct.'),
    );
  });

  it('turning on re-checks readiness fresh and refuses, naming what to fix', async () => {
    const { svc, readiness, upserts } = build({ ready: false, failing: ['wallet', 'keysAndIp'] });
    await expect(svc.setBasicSwitch(OWNER, { enabled: true, password: 'pw' })).rejects.toThrow(
      new ConflictException("Basic can't be switched on yet: wallet failing; keysAndIp failing."),
    );
    expect(readiness.report).toHaveBeenCalledWith(true);
    expect(upserts).toHaveLength(0);
  });

  it('turning off never needs readiness; null goes back to the server default', async () => {
    const { svc, current } = build({ ready: false, stored: { basicEnabled: true, minBalance: 9000 } });
    await svc.setBasicSwitch(OWNER, { enabled: false, password: 'pw' });
    expect(current()).toEqual({ basicEnabled: false, minBalance: 9000 });
    await svc.setBasicSwitch(OWNER, { enabled: null, password: 'pw' });
    expect(current()).toEqual({ minBalance: 9000 });
  });
});

describe('The calculator', () => {
  it('gives the same numbers as the script, with the working in plain words', async () => {
    const r = await build().svc.suggest({ lookupPrice: 100, amlPrice: 50 });
    const expected = dojahThresholds({ lookupPrice: 100, amlPrice: 50, peakHour: 12, peakDay: 90, leadDays: 3 });
    expect(r).toMatchObject({ minBalance: expected.minBalance, lowBalanceWarn: expected.lowBalanceWarn });
    expect(r.workings[0]).toBe('One verification can cost up to ₦200 (one BVN/NIN check at ₦100 plus up to two screenings at ₦50).');
    expect(r.workings.join(' ')).toContain('busiest hour');
  });

  it('refuses missing or zero prices in plain words', async () => {
    await expect(build().svc.suggest({ lookupPrice: 0, amlPrice: 50 })).rejects.toThrow(
      new BadRequestException('Enter the price per check and per screening in naira.'),
    );
  });
});
