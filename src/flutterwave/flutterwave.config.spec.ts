import { FlutterwaveConfig, MOCK_WEBHOOK_HASH } from './flutterwave.config';
import { FlutterwaveError, redactIds } from './flutterwave.errors';
import { keyModeProblem } from './key-mode';

const TEST_KEY = 'FLWSECK_TEST-abc123-X';
const LIVE_KEY = 'FLWSECK-abc123-X';

function cfg(opts: { key?: string; hash?: string; env?: string; mock?: boolean }) {
  const config = {
    get: (k: string) =>
      ({ NODE_ENV: opts.env ?? 'development', FLW_USE_MOCK: opts.mock ?? false, PORT: 3000 } as Record<string, unknown>)[k],
  };
  const credentials = {
    get: async (name: string) =>
      name === 'flutterwave.secretKey' ? opts.key : name === 'flutterwave.secretHash' ? opts.hash : undefined,
  };
  return new FlutterwaveConfig(config as never, credentials as never);
}

describe('keyModeProblem', () => {
  it('allows a test key outside production and a live key in production', () => {
    expect(keyModeProblem(TEST_KEY, 'development')).toBeNull();
    expect(keyModeProblem(TEST_KEY, 'staging')).toBeNull();
    expect(keyModeProblem(LIVE_KEY, 'production')).toBeNull();
  });

  it('refuses a test key in production', () => {
    expect(keyModeProblem(TEST_KEY, 'production')).toMatch(/TEST key .* cannot be used in production/);
  });

  it('refuses a live key anywhere but production', () => {
    expect(keyModeProblem(LIVE_KEY, 'development')).toMatch(/LIVE key can only be used in production/);
    expect(keyModeProblem(LIVE_KEY, 'test')).toMatch(/LIVE key/);
  });
});

describe('FlutterwaveConfig', () => {
  it('hands back an allowed key', async () => {
    await expect(cfg({ key: TEST_KEY }).secretKey()).resolves.toBe(TEST_KEY);
  });

  it('refuses a missing key as a CONFIG error', async () => {
    const err = await cfg({}).secretKey().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlutterwaveError);
    expect((err as FlutterwaveError).kind).toBe('CONFIG');
  });

  it('refuses a key in the wrong mode as a CONFIG error, never naming the key', async () => {
    const err = (await cfg({ key: LIVE_KEY, env: 'development' }).secretKey().catch((e: unknown) => e)) as FlutterwaveError;
    expect(err.kind).toBe('CONFIG');
    expect(err.message).not.toContain(LIVE_KEY);
  });

  it('uses the mock hash only when the mock is on and no hash is configured', async () => {
    await expect(cfg({ mock: true }).secretHash()).resolves.toBe(MOCK_WEBHOOK_HASH);
    await expect(cfg({ mock: false }).secretHash()).resolves.toBeNull();
    await expect(cfg({ mock: true, hash: 'real-hash' }).secretHash()).resolves.toBe('real-hash');
  });

  it('reports key status without exposing the key', async () => {
    await expect(cfg({}).keyStatus()).resolves.toEqual({ present: false, problem: null });
    const status = await cfg({ key: LIVE_KEY, env: 'development' }).keyStatus();
    expect(status.present).toBe(true);
    expect(status.problem).toMatch(/LIVE key/);
    expect(JSON.stringify(status)).not.toContain(LIVE_KEY);
  });
});

describe('redactIds', () => {
  it('redacts exactly-11-digit runs (BVN, NIN, phone) and nothing shorter or longer', () => {
    expect(redactIds('BVN 22222223883 is invalid')).toBe('BVN [REDACTED] is invalid');
    expect(redactIds('tx 10535993 acct 0067100155')).toBe('tx 10535993 acct 0067100155');
    expect(redactIds('session 1155648034391791382464103')).toBe('session 1155648034391791382464103');
  });
});
