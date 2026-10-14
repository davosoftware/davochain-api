import { DojahReadinessService } from './dojah-readiness.service';
import { DojahError } from './dojah.errors';

function setup(o: { env?: string; mock?: boolean; min?: number; warn?: number | null; balance?: () => Promise<number>; recipients?: string[]; enabled?: boolean; creds?: boolean } = {}) {
  const cfg = {
    nodeEnv: o.env ?? 'production',
    useMock: o.mock ?? false,
    baseUrl: 'https://api.dojah.io',
    minBalance: o.min ?? 8000,
    lowBalanceWarn: o.warn ?? null,
    basicEnabled: o.enabled ?? true,
    credentials: async () => {
      if (o.creds === false) throw new DojahError('CONFIG', 'missing', 0);
      return { appId: 'a', secretKey: 's' };
    },
  };
  const dojah = { balance: jest.fn(o.balance ?? (async () => 20000)) };
  const recipients = { resolve: jest.fn(async () => o.recipients ?? ['ops@x.test']) };
  const alerts = { raise: jest.fn(async (..._a: unknown[]) => true) };
  const prisma = { $queryRaw: jest.fn(async () => [{ peak: 0 }]) };
  let now = 1_000_000;
  const svc = new DojahReadinessService(cfg as never, dojah as never, recipients as never, alerts as never, prisma as never, () => now);
  return { svc, dojah, alerts, advance: (ms: number) => (now += ms) };
}

describe('DojahReadinessService', () => {
  it('ready when every required check passes', async () => {
    const r = await setup().svc.report();
    expect(r.ready).toBe(true);
    expect(r.balance).toMatchObject({ naira: 20000, minimum: 8000 });
  });

  it('a wallet below the minimum is not ready, with an alert', async () => {
    const { svc, alerts } = setup({ balance: async () => 7999.99 });
    const r = await svc.report();
    expect(r.ready).toBe(false);
    expect(r.checks.find((c) => c.key === 'wallet')).toMatchObject({ ok: false, required: true });
    expect(alerts.raise).toHaveBeenCalledWith('DOJAH_CONFIG', 'dojah:not-ready', expect.any(String), expect.any(Array));
    await expect(svc.assertReady()).rejects.toThrow();
  });

  it('the wallet is not required outside production (the sandbox wallet is always 0.00)', async () => {
    const r = await setup({ env: 'development', min: 0, balance: async () => 0 }).svc.report();
    expect(r.checks.find((c) => c.key === 'wallet')).toMatchObject({ required: false });
    expect(r.ready).toBe(true);
  });

  it('a low (not empty) wallet warns but stays ready', async () => {
    const { svc, alerts } = setup({ warn: 152000 });
    expect((await svc.report()).ready).toBe(true);
    expect(alerts.raise).toHaveBeenCalledWith('DOJAH_CONFIG', 'dojah:low-balance', expect.any(String), expect.any(Array));
  });

  it('401/403 on balance: keys or IP whitelist, not ready', async () => {
    const r = await setup({ balance: async () => { throw new DojahError('IP', 'x', 403); } }).svc.report();
    expect(r.checks.find((c) => c.key === 'keysAndIp')).toMatchObject({ ok: false, detail: expect.stringMatching(/keys or IP whitelist/) });
    expect(r.ready).toBe(false);
  });

  it('missing credentials are not ready, and the balance is never asked', async () => {
    const { svc, dojah } = setup({ creds: false });
    const r = await svc.report();
    expect(r.checks.find((c) => c.key === 'credentials')).toMatchObject({ ok: false });
    expect(r.ready).toBe(false);
    expect(dojah.balance).not.toHaveBeenCalled();
  });

  it('timeout: uses the last good balance if under 5 minutes old, else fails closed', async () => {
    let fail = false;
    const { svc, advance } = setup({ balance: async () => { if (fail) throw new DojahError('UNKNOWN', 't', 0); return 20000; } });
    await svc.report(true);
    fail = true;
    advance(4 * 60_000);
    expect((await svc.report(true)).ready).toBe(true);
    advance(2 * 60_000);
    const r = await svc.report(true);
    expect(r.ready).toBe(false);
    expect(r.checks.find((c) => c.key === 'keysAndIp')!.detail).toMatch(/could not reach Dojah/);
  });

  it('caches for 60 s: one balance call per minute, however many submissions', async () => {
    const { svc, dojah, advance } = setup();
    await svc.assertReady();
    await svc.assertReady();
    expect(dojah.balance).toHaveBeenCalledTimes(1);
    advance(61_000);
    await svc.assertReady();
    expect(dojah.balance).toHaveBeenCalledTimes(2);
  });

  it('a 402 seen by a lookup marks it not ready at once', async () => {
    const { svc } = setup();
    await svc.assertReady();
    svc.markNotReady('wallet');
    await expect(svc.assertReady()).rejects.toThrow();
  });

  it('a later successful balance clears a wallet override only when the wallet is funded', async () => {
    const { svc } = setup();
    svc.markNotReady('wallet');
    expect((await svc.report(true)).ready).toBe(true);
  });

  it('no recipient for an AML type is not ready', async () => {
    expect((await setup({ recipients: [] }).svc.report()).checks.find((c) => c.key === 'recipients')).toMatchObject({ ok: false });
  });

  it('the mock in production is not ready', async () => {
    expect((await setup({ mock: true }).svc.report()).checks.find((c) => c.key === 'mode')).toMatchObject({ ok: false });
  });
});

it('a refusal seen by a real call lapses after one cache window', async () => {
  const { svc, advance } = setup();
  svc.markNotReady('keys');
  await expect(svc.assertReady()).rejects.toThrow();
  advance(61_000);
  await expect(svc.assertReady()).resolves.toBeUndefined();
});
