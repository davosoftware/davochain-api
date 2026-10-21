import { FlutterwaveError } from '../flutterwave/flutterwave.errors';
import { FakePrisma } from './testing/fake-prisma';
import { ReadinessService } from './readiness.service';

interface Opts {
  mock?: boolean;
  env?: string;
  enabled?: boolean;
  key?: { present: boolean; problem: string | null };
  hash?: string | null;
  balanceError?: Error;
}

function setup(o: Opts = {}) {
  const db = new FakePrisma();
  const cfg = {
    useMock: o.mock ?? false,
    nodeEnv: o.env ?? 'development',
    keyStatus: async () => o.key ?? { present: true, problem: null },
    secretHash: async () => (o.hash === undefined ? 'hash' : o.hash),
  };
  const client = {
    getBalance: jest.fn(async () => {
      if (o.balanceError) throw o.balanceError;
      return { currency: 'NGN', available_balance: '5000.25', ledger_balance: '6000' };
    }),
  };
  const config = { get: (k: string) => (k === 'NGN_DEPOSITS_ENABLED' ? (o.enabled ?? true) : undefined) };
  const alerts = { raise: jest.fn(async () => true) };
  const svc = new ReadinessService(cfg as never, client as never, db as never, config as never, alerts as never);
  return { db, client, alerts, svc };
}

const ok = (r: { checks: Array<{ key: string; ok: boolean }> }, key: string) => r.checks.find((c) => c.key === key)?.ok;

describe('ReadinessService', () => {
  it('is green with a usable key, a hash, and Flutterwave answering', async () => {
    const r = await setup().svc.report();
    expect(r).toMatchObject({
      mode: 'TEST',
      depositsEnabled: true,
      canCreateAccounts: true,
      webhookPath: '/webhooks/flutterwave',
      balance: { currency: 'NGN', available: '5000.25', ledger: '6000' },
    });
    expect(r.checks.filter((c) => c.required).every((c) => c.ok)).toBe(true);
  });

  it('probes the balance once, without retries, so a slow Flutterwave cannot stall the screen', async () => {
    const { svc, client } = setup();
    await svc.report();
    expect(client.getBalance).toHaveBeenCalledWith('NGN', { probe: true });
  });

  it('shares one check between concurrent requests', async () => {
    const { svc, client } = setup();
    const reports = await Promise.all([svc.report(), svc.report(), svc.report(true)]);
    expect(client.getBalance).toHaveBeenCalledTimes(1);
    expect(reports[0]).toBe(reports[1]);
    expect(reports[1]).toBe(reports[2]);
  });

  it('says LIVE in production', async () => {
    expect((await setup({ env: 'production' }).svc.report()).mode).toBe('LIVE');
  });

  it('lets the development mock open accounts, though "mock is off" is red', async () => {
    const r = await setup({ mock: true }).svc.report();
    expect(r.mode).toBe('MOCK');
    expect(ok(r, 'mockOff')).toBe(false);
    expect(r.canCreateAccounts).toBe(true);
  });

  it('opens nothing while NGN_DEPOSITS_ENABLED is off', async () => {
    expect((await setup({ enabled: false }).svc.report()).canCreateAccounts).toBe(false);
  });

  it('turns red, without calling Flutterwave, on a key in the wrong mode, and raises an alert', async () => {
    const { svc, client, alerts } = setup({
      key: { present: true, problem: 'A Flutterwave LIVE key can only be used in production (NODE_ENV is development)' },
    });
    const r = await svc.report();
    expect(ok(r, 'secretKey')).toBe(false);
    expect(ok(r, 'reachable')).toBe(false);
    expect(r.canCreateAccounts).toBe(false);
    expect(client.getBalance).not.toHaveBeenCalled();
    expect(alerts.raise).toHaveBeenCalledWith('NAIRA_RAIL_CONFIG', 'config', expect.any(String), expect.any(Array));
  });

  it('turns red when the key or the hash is missing', async () => {
    expect((await setup({ key: { present: false, problem: null } }).svc.report()).canCreateAccounts).toBe(false);
    const noHash = await setup({ hash: null }).svc.report();
    expect(ok(noHash, 'secretHash')).toBe(false);
    expect(noHash.canCreateAccounts).toBe(false);
  });

  it('turns red and alerts when Flutterwave refuses our credentials', async () => {
    const { svc, alerts } = setup({
      balanceError: new FlutterwaveError('CONFIG', 'Please enable IP Whitelisting to access this service', 400),
    });
    const r = await svc.report();
    expect(ok(r, 'reachable')).toBe(false);
    expect(r.canCreateAccounts).toBe(false);
    expect(alerts.raise).toHaveBeenCalled();
  });

  it('caches for a minute unless forced', async () => {
    const { svc, client } = setup();
    await svc.report();
    await svc.report();
    expect(client.getBalance).toHaveBeenCalledTimes(1);
    await svc.report(true);
    expect(client.getBalance).toHaveBeenCalledTimes(2);
  });

  it('reports the last authenticated Flutterwave webhook, for information only', async () => {
    const { db, svc } = setup();
    const event = (eventName: string, signatureValid: boolean, at: string) =>
      db.webhookEvent.create({ data: { eventName, dedupHash: at, payload: {}, signatureValid, receivedAt: new Date(at) } });
    await event('flutterwave.charge', true, '2026-10-07T10:00:00.000Z');
    await event('flutterwave.unauthenticated', false, '2026-10-07T11:00:00.000Z');
    await event('quidax.deposit', true, '2026-10-07T12:00:00.000Z');
    expect((await svc.report()).lastWebhookAt).toBe('2026-10-07T10:00:00.000Z');
  });
});
