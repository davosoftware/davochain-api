import { envSchema } from './env.validation';
import { setupSwagger } from '../common/swagger';
import { HealthController } from '../common/health.controller';

/**
 * M13 (PROJECT_REVIEW): only "production" refused the Quidax mock. A staging
 * server could run it, and the mock accepts UNSIGNED webhooks: anyone could
 * credit balances there. Swagger was open on staging too, and the public
 * /health page said which environment and Quidax mode a server was in.
 */
const BASE = {
  DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
  JWT_SECRET: 'j'.repeat(32),
  JWT_REFRESH_SECRET: 'r'.repeat(32),
  ADMIN_JWT_SECRET: 'a'.repeat(32),
};
const quidaxMockIssues = (env: Record<string, string>) => {
  const parsed = envSchema.safeParse({ ...BASE, ...env });
  return parsed.success ? [] : parsed.error.issues.filter((i) => i.path.join('.') === 'QUIDAX_USE_MOCK').map((i) => i.message);
};

describe('M13: the Quidax mock runs only in development and test', () => {
  it.each(['development', 'test'])('%s may use it', (env) => {
    expect(quidaxMockIssues({ NODE_ENV: env, QUIDAX_USE_MOCK: 'true' })).toEqual([]);
  });

  it('staging may not', () => {
    expect(quidaxMockIssues({ NODE_ENV: 'staging', QUIDAX_USE_MOCK: 'true' })).toEqual([
      'QUIDAX_USE_MOCK=true is only allowed in development and test',
    ]);
  });
});

describe('M13: the API docs are off on staging unless switched on', () => {
  const config = (env: Record<string, string | undefined>) => ({ get: (k: string) => env[k] }) as never;
  it.each([
    ['staging', undefined, null],
    ['production', undefined, null],
  ])('%s (ENABLE_DOCS=%s) serves no docs', (NODE_ENV, ENABLE_DOCS, expected) => {
    expect(setupSwagger({} as never, config({ NODE_ENV, ENABLE_DOCS }))).toBe(expected);
  });
});

describe('M13: /health says nothing about the setup', () => {
  it('reports status and database only', async () => {
    const ctl = new HealthController({ $queryRaw: jest.fn(async () => [1]) } as never);
    const body = await ctl.check();
    expect(Object.keys(body).sort()).toEqual(['database', 'status', 'time']);
  });
});
