import { envSchema } from './env.validation';

/** The minimum the rest of the schema needs, so these tests see only storage rules. */
const BASE = {
  DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
  JWT_SECRET: 'j'.repeat(32),
  JWT_REFRESH_SECRET: 'r'.repeat(32),
  ADMIN_JWT_SECRET: 'a'.repeat(32),
};

function issues(raw: Record<string, string>, path: string): string[] {
  const parsed = envSchema.safeParse({ ...BASE, ...raw });
  if (parsed.success) return [];
  return parsed.error.issues.filter((i) => i.path.join('.') === path).map((i) => i.message);
}

const R2 = {
  STORAGE_DRIVER: 'r2',
  R2_ACCOUNT_ID: 'acc',
  R2_ACCESS_KEY_ID: 'id',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'davochain-files',
};

describe('File storage environment rules', () => {
  it('defaults to the in-memory store, allowed in development and test', () => {
    expect(envSchema.parse({ ...BASE, NODE_ENV: 'development' }).STORAGE_DRIVER).toBe('memory');
    expect(issues({ NODE_ENV: 'test' }, 'STORAGE_DRIVER')).toEqual([]);
  });

  it('refuses the in-memory store in staging and production, where files must survive a restart', () => {
    expect(issues({ NODE_ENV: 'production' }, 'STORAGE_DRIVER')[0]).toMatch(/only allowed in development and test/);
    expect(issues({ NODE_ENV: 'staging', STORAGE_DRIVER: 'memory' }, 'STORAGE_DRIVER')[0]).toMatch(/only allowed/);
  });

  it('names every R2 setting that is missing', () => {
    for (const name of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) {
      const raw: Record<string, string> = { ...R2 };
      delete raw[name];
      expect(issues(raw, name)[0]).toMatch(/required when STORAGE_DRIVER=r2/);
    }
  });

  it('accepts a complete R2 setup in production', () => {
    expect(issues({ NODE_ENV: 'production', ...R2 }, 'STORAGE_DRIVER')).toEqual([]);
    expect(issues({ NODE_ENV: 'production', ...R2 }, 'R2_BUCKET')).toEqual([]);
  });

  it('refuses an unknown driver', () => {
    expect(issues({ STORAGE_DRIVER: 's3' }, 'STORAGE_DRIVER').length).toBeGreaterThan(0);
  });
});
