import { MOCK_WEBHOOK_SECRET, PayrepConfig } from './payrep.config';

const cfg = (env: Record<string, unknown>, creds: Record<string, string>) =>
  new PayrepConfig({ get: (k: string) => env[k] } as never, { get: async (n: string) => creds[n] ?? null } as never);

describe('PayrepConfig', () => {
  it('the mock uses the fixed mock webhook secret; otherwise the stored one, and null when unset', async () => {
    expect(await cfg({ PAYREP_USE_MOCK: true }, {}).webhookSecret()).toBe(MOCK_WEBHOOK_SECRET);
    expect(MOCK_WEBHOOK_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(await cfg({ PAYREP_USE_MOCK: false }, { 'payrep.webhookSecret': 'b'.repeat(64) }).webhookSecret()).toBe('b'.repeat(64));
    expect(await cfg({ PAYREP_USE_MOCK: false }, {}).webhookSecret()).toBeNull();
  });
  it('credentials() throws CONFIG when missing or in the wrong mode, never naming the key', async () => {
    await expect(cfg({ PAYREP_USE_MOCK: false }, {}).credentials()).rejects.toMatchObject({ kind: 'CONFIG' });
    const err = await cfg({ PAYREP_USE_MOCK: false, NODE_ENV: 'development' }, { 'payrep.clientId': 'pk_live_x', 'payrep.clientSecret': 'sk_live_y' })
      .credentials()
      .catch((e: Error) => e);
    expect(err).toMatchObject({ kind: 'CONFIG' });
    expect((err as Error).message).not.toContain('sk_live_y');
    await expect(cfg({}, { 'payrep.clientId': 'pk_test_x', 'payrep.clientSecret': 'sk_test_y' }).credentials()).resolves.toEqual({ clientId: 'pk_test_x', clientSecret: 'sk_test_y' });
  });
  it('mainAccount is null when unset or empty', () => {
    expect(cfg({ PAYREP_MAIN_ACCOUNT: '' }, {}).mainAccount).toBeNull();
    expect(cfg({ PAYREP_MAIN_ACCOUNT: '7801234567' }, {}).mainAccount).toBe('7801234567');
  });
  it('keyStatus reports presence and mode problems', async () => {
    expect(await cfg({}, {}).keyStatus()).toEqual({ present: false, problem: null });
    expect(await cfg({ NODE_ENV: 'production' }, { 'payrep.clientId': 'pk_test_x', 'payrep.clientSecret': 'sk_test_y' }).keyStatus()).toMatchObject({ present: true, problem: expect.stringMatching(/TEST/) });
  });
});
