import { PayrepError } from '../payrep/payrep.errors';
import { FakePrisma } from './testing/fake-prisma';
import { ReadinessService } from './readiness.service';

interface Opts {
  mock?: boolean;
  env?: string;
  enabled?: boolean;
  key?: { present: boolean; problem: string | null };
  secret?: string | null;
  main?: string | null;
  account?: { status: string; balance?: string };
  accountError?: Error;
  slowMs?: number;
}

function setup(o: Opts = {}) {
  const db = new FakePrisma();
  const cfg = {
    useMock: o.mock ?? false,
    nodeEnv: o.env ?? 'development',
    mainAccount: o.main === undefined ? '7801234567' : o.main,
    keyStatus: async () => o.key ?? { present: true, problem: null },
    webhookSecret: async () => (o.secret === undefined ? 'a'.repeat(64) : o.secret),
  };
  const payrep = {
    account: jest.fn(async (accountNumber: string) => {
      if (o.slowMs) await new Promise((r) => setTimeout(r, o.slowMs));
      if (o.accountError) throw o.accountError;
      return { accountNumber, accountName: 'DAVOCHAIN', status: o.account?.status ?? 'active', balance: o.account?.balance ?? '5000.25' };
    }),
  };
  const config = { get: (k: string) => (k === 'NGN_DEPOSITS_ENABLED' ? (o.enabled ?? true) : undefined) };
  const alerts = { raise: jest.fn(async () => true) };
  const svc = new ReadinessService(cfg as never, payrep as never, db as never, config as never, alerts as never);
  return { db, payrep, alerts, svc };
}

const check = (r: { checks: Array<{ key: string; ok: boolean }> }, key: string) => r.checks.find((c) => c.key === key);

describe('ReadinessService (Payrep)', () => {
  it('is green with usable keys, a webhook secret, a main account and Payrep answering', async () => {
    const r = await setup().svc.report();
    expect(r).toMatchObject({
      mode: 'TEST',
      depositsEnabled: true,
      canCreateAccounts: true,
      webhookPath: '/webhooks/payrep',
      balance: { currency: 'NGN', available: '5000.25', ledger: '5000.25' },
    });
    expect(r.checks.map((c) => c.key)).toEqual(['mockOff', 'credentials', 'webhookSecret', 'mainAccount', 'reachable', 'lastWebhook']);
    expect(r.checks.filter((c) => c.required).every((c) => c.ok)).toBe(true);
  });

  it('reads our main account balance', async () => {
    const { svc, payrep } = setup();
    await svc.report();
    expect(payrep.account).toHaveBeenCalledWith('7801234567');
  });

  it('a slow Payrep cannot stall the screen: the probe gives up after a few seconds', async () => {
    jest.useFakeTimers();
    try {
      const { svc } = setup({ slowMs: 60_000 });
      const p = svc.report();
      await jest.advanceTimersByTimeAsync(6_000);
      const r = await p;
      expect(check(r, 'reachable')).toMatchObject({ ok: false, detail: expect.stringMatching(/did not answer/) });
    } finally {
      jest.useRealTimers();
    }
  });

  it('shares one check between concurrent requests', async () => {
    const { svc, payrep } = setup();
    const reports = await Promise.all([svc.report(), svc.report(), svc.report(true)]);
    expect(payrep.account).toHaveBeenCalledTimes(1);
    expect(reports[0]).toBe(reports[1]);
    expect(reports[1]).toBe(reports[2]);
  });

  it('says LIVE in production', async () => {
    expect((await setup({ env: 'production' }).svc.report()).mode).toBe('LIVE');
  });

  it('lets the development mock open accounts, though "mock is off" is red', async () => {
    const r = await setup({ mock: true }).svc.report();
    expect(r.mode).toBe('MOCK');
    expect(check(r, 'mockOff')?.ok).toBe(false);
    expect(r.canCreateAccounts).toBe(true);
  });

  it('opens nothing while NGN_DEPOSITS_ENABLED is off', async () => {
    expect((await setup({ enabled: false }).svc.report()).canCreateAccounts).toBe(false);
  });

  it('turns red, without calling Payrep, on keys in the wrong mode, and raises an alert', async () => {
    const { svc, payrep, alerts } = setup({ key: { present: true, problem: 'Payrep LIVE keys can only be used in production (NODE_ENV is development)' } });
    const r = await svc.report();
    expect(check(r, 'credentials')?.ok).toBe(false);
    expect(check(r, 'reachable')?.ok).toBe(false);
    expect(r.canCreateAccounts).toBe(false);
    expect(payrep.account).not.toHaveBeenCalled();
    expect(alerts.raise).toHaveBeenCalledWith('NAIRA_RAIL_CONFIG', 'config', expect.any(String), expect.any(Array));
  });

  it('turns red when the keys, the webhook secret or the main account are missing', async () => {
    expect((await setup({ key: { present: false, problem: null } }).svc.report()).canCreateAccounts).toBe(false);
    const noSecret = await setup({ secret: null }).svc.report();
    expect(check(noSecret, 'webhookSecret')?.ok).toBe(false);
    expect(noSecret.canCreateAccounts).toBe(false);
    const noMain = await setup({ main: null }).svc.report();
    expect(check(noMain, 'mainAccount')?.ok).toBe(false);
    expect(check(noMain, 'reachable')?.ok).toBe(false);
    expect(noMain.canCreateAccounts).toBe(false);
  });

  it('a main account that is not active fails "reachable"', async () => {
    const r = await setup({ account: { status: 'blocked' } }).svc.report();
    expect(check(r, 'reachable')).toMatchObject({ ok: false, detail: expect.stringMatching(/blocked/) });
    expect(r.canCreateAccounts).toBe(false);
  });

  it('turns red and alerts when Payrep refuses our keys', async () => {
    const { svc, alerts } = setup({ accountError: new PayrepError('CONFIG', 'Unauthorized - invalid API credentials', 200, '41') });
    const r = await svc.report();
    expect(check(r, 'reachable')?.ok).toBe(false);
    expect(r.canCreateAccounts).toBe(false);
    expect(alerts.raise).toHaveBeenCalledWith('NAIRA_RAIL_CONFIG', 'config', expect.any(String), expect.any(Array));
  });

  it('caches for a minute unless forced', async () => {
    const { svc, payrep } = setup();
    await svc.report();
    await svc.report();
    expect(payrep.account).toHaveBeenCalledTimes(1);
    await svc.report(true);
    expect(payrep.account).toHaveBeenCalledTimes(2);
  });

  it('reports the last authenticated Payrep webhook, for information only', async () => {
    const { db, svc } = setup();
    const event = (eventName: string, signatureValid: boolean, at: string) =>
      db.webhookEvent.create({ data: { eventName, dedupHash: at, payload: {}, signatureValid, receivedAt: new Date(at) } });
    await event('payrep.deposit.success', true, '2026-10-07T10:00:00.000Z');
    await event('payrep.unauthenticated', false, '2026-10-07T11:00:00.000Z');
    await event('quidax.deposit', true, '2026-10-07T12:00:00.000Z');
    expect((await svc.report()).lastWebhookAt).toBe('2026-10-07T10:00:00.000Z');
  });
});
