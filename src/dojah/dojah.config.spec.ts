import { DojahConfig } from './dojah.config';
import { DojahError } from './dojah.errors';

function cfg(env: Record<string, unknown>, creds: Record<string, string | undefined> = {}) {
  const config = { get: (k: string) => env[k] };
  const credentials = { get: async (k: string) => creds[k] };
  return new DojahConfig(config as never, credentials as never, {} as never);
}

describe('DojahConfig', () => {
  it('is off, mocked and free of thresholds by default outside production', () => {
    const c = cfg({ NODE_ENV: 'development' });
    expect(c.basicEnabled).toBe(false);
    expect(c.useMock).toBe(true);
    expect(c.minBalance).toBe(0);
    expect(c.lowBalanceWarn).toBeNull();
    expect(c.baseUrl).toBe('https://sandbox.dojah.io');
  });

  it('reads thresholds as naira numbers', () => {
    const c = cfg({ NODE_ENV: 'production', DOJAH_USE_MOCK: false, DOJAH_MIN_BALANCE: '8000', DOJAH_LOW_BALANCE_WARN: '152000.50' });
    expect(c.minBalance).toBe(8000);
    expect(c.lowBalanceWarn).toBe(152000.5);
  });

  it('refuses to call Dojah without both credentials', async () => {
    await expect(cfg({ NODE_ENV: 'development', DOJAH_USE_MOCK: false }, { 'dojah.appId': 'a' }).credentials()).rejects.toBeInstanceOf(DojahError);
    await expect(cfg({ NODE_ENV: 'development', DOJAH_USE_MOCK: false }, { 'dojah.appId': 'a', 'dojah.secretKey': 's' }).credentials()).resolves.toEqual({ appId: 'a', secretKey: 's' });
  });
});
