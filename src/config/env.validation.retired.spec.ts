import { readFileSync } from 'fs';
import { Logger } from '@nestjs/common';
import { envSchema, validateEnv } from './env.validation';

const BASE = {
  DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
  JWT_SECRET: 'j'.repeat(32),
  JWT_REFRESH_SECRET: 'r'.repeat(32),
  ADMIN_JWT_SECRET: 'a'.repeat(32),
};
const RETIRED = ['MAX_USER_DAILY_USD', 'MAX_PLATFORM_DAILY_USD', 'MAX_TRADE_USD'];

/** Level policy (15 Oct 2026): trading limits moved to System → Verification levels. */
describe('The MAX_* trading settings are retired', () => {
  it('an existing .env that still sets them keeps starting', () => {
    expect(envSchema.safeParse({ ...BASE, MAX_USER_DAILY_USD: '5000', MAX_PLATFORM_DAILY_USD: '50000', MAX_TRADE_USD: '2000' }).success).toBe(true);
  });

  it('nothing in trading reads them any more', () => {
    for (const file of ['src/quotes/quotes.service.ts', 'src/trades/trades.service.ts']) {
      const src = readFileSync(file, 'utf8');
      for (const key of RETIRED) expect(src).not.toContain(key);
    }
  });

  it('startup says they are no longer used, once each', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    validateEnv({ ...BASE, MAX_TRADE_USD: '2000' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MAX_TRADE_USD is no longer used'));
    expect(warn.mock.calls.filter(([m]) => String(m).includes('MAX_'))).toHaveLength(1);
    warn.mockRestore();
  });
});

/** Payrep replaced Flutterwave (21 Oct 2026): an old .env still starts, and says what to remove. */
describe('The FLW_* settings are retired', () => {
  it('an existing .env that still sets them keeps starting, and startup names each one', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const env = { ...BASE, FLW_USE_MOCK: 'true', FLW_SECRET_KEY: 'FLWSECK_TEST-x', FLW_SECRET_HASH: 'h', FLW_BASE_URL: 'https://api.flutterwave.com/v3', FLW_RATE_LIMIT_PER_MINUTE: '120' };
    expect(() => validateEnv(env)).not.toThrow();
    const said = warn.mock.calls.map(([m]) => String(m));
    for (const key of ['FLW_USE_MOCK', 'FLW_SECRET_KEY', 'FLW_SECRET_HASH', 'FLW_BASE_URL', 'FLW_RATE_LIMIT_PER_MINUTE']) {
      expect(said).toContainEqual(expect.stringMatching(new RegExp(`^${key} is no longer used: .*Payrep`)));
    }
    expect(said.join(' ')).not.toContain('FLWSECK_TEST-x');
    warn.mockRestore();
  });
});

/** Server settings (26 Oct 2026): trading is paused and resumed with the dashboard's trading halt. */
describe('TRADING_ENABLED is retired', () => {
  it('an existing .env that still sets it keeps starting, and startup says what replaced it', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(() => validateEnv({ ...BASE, TRADING_ENABLED: 'false' })).not.toThrow();
    expect(warn.mock.calls.map(([m]) => String(m))).toContainEqual(expect.stringMatching(/^TRADING_ENABLED is no longer used: .*trading halt/));
    warn.mockRestore();
  });

  it('it is not a setting any more', () => {
    expect(Object.keys((envSchema as unknown as { _def: { schema: { shape: object } } })._def.schema.shape)).not.toContain('TRADING_ENABLED');
  });
});
