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
