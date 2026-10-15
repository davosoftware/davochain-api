import { DojahConfig, DOJAH_SETTINGS_FLAG } from './dojah.config';

/**
 * The Dojah screen sets the hard stop, warning level, tries and the Basic
 * switch. A value set there wins over api/.env; anything unset (or junk) uses
 * the server default. Read fresh every time, so a change applies at once.
 */
function cfg(env: Record<string, unknown>, stored: unknown) {
  const config = { get: (k: string) => env[k] };
  const prisma = { systemFlag: { findUnique: jest.fn(async ({ where }: { where: { key: string } }) => (where.key === DOJAH_SETTINGS_FLAG && stored !== undefined ? { value: stored } : null)) } };
  return { c: new DojahConfig(config as never, {} as never, prisma as never), prisma };
}
const ENV = { DOJAH_MIN_BALANCE: '8000', DOJAH_LOW_BALANCE_WARN: '20000', KYC_BASIC_DAILY_ATTEMPTS: 3, KYC_BASIC_TOTAL_ATTEMPTS: 10, KYC_BASIC_ENABLED: true };

describe('Dojah settings: the screen first, then the server default', () => {
  it('with nothing set on the screen, everything is the server default', async () => {
    const s = await cfg(ENV, undefined).c.effective();
    expect(s).toMatchObject({ minBalance: 8000, lowBalanceWarn: 20000, dailyAttempts: 3, totalAttempts: 10, basicEnabled: true });
    expect(Object.values(s.source).every((v) => v === 'server')).toBe(true);
  });

  it('a value set on the screen wins, and says so', async () => {
    const s = await cfg(ENV, { minBalance: 10000, dailyAttempts: 5, basicEnabled: false }).c.effective();
    expect(s).toMatchObject({ minBalance: 10000, lowBalanceWarn: 20000, dailyAttempts: 5, totalAttempts: 10, basicEnabled: false });
    expect(s.source).toMatchObject({ minBalance: 'screen', dailyAttempts: 'screen', basicEnabled: 'screen', lowBalanceWarn: 'server', totalAttempts: 'server' });
  });

  it('junk in the stored row is ignored field by field', async () => {
    const s = await cfg(ENV, { minBalance: 'abc', lowBalanceWarn: -5, dailyAttempts: 2.5, totalAttempts: 0, basicEnabled: 'yes' }).c.effective();
    expect(s).toMatchObject({ minBalance: 8000, lowBalanceWarn: 20000, dailyAttempts: 3, totalAttempts: 10, basicEnabled: true });
  });

  it('reads the row fresh on every call', async () => {
    const { c, prisma } = cfg(ENV, { minBalance: 9000 });
    await c.effective();
    await c.effective();
    expect(prisma.systemFlag.findUnique).toHaveBeenCalledTimes(2);
  });
});
