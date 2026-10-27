import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ServerSettingsService, SERVER_SETTINGS_FLAG } from './server-settings.service';
import { SERVER_SETTINGS } from './server-settings.registry';

/** The Server settings screen (spec 2026-10-26): dashboard value, else .env; owners only; audited. */
const OWNER = { id: 'owner-1', role: 'OWNER' as const, email: 'owner@davochain.com', name: 'Ada Owner' };
const SUB = { id: 'sub-1', role: 'SUB_ADMIN' as const, email: 'sub@davochain.com', name: 'Sub' };
const PASSWORD = 'Right-password-1';
const REASON = 'Switching naira deposits on for launch';

function build(env: Record<string, unknown> = {}) {
  const flags = new Map<string, { value: unknown; updatedBy?: string }>();
  const audit: Array<Record<string, unknown>> = [];
  const prisma = {
    systemFlag: {
      findUnique: jest.fn(async ({ where }: { where: { key: string } }) => (flags.has(where.key) ? { key: where.key, ...flags.get(where.key)! } : null)),
      upsert: jest.fn(async ({ where, create, update }: { where: { key: string }; create: { value: unknown; updatedBy: string }; update: { value: unknown; updatedBy: string } }) => {
        flags.set(where.key, flags.has(where.key) ? update : create);
      }),
    },
    adminUser: {
      findUnique: jest.fn(async () => ({ passwordHash: 'hash' })),
      findMany: jest.fn(async () => [{ email: 'owner@davochain.com' }, { email: 'owner2@davochain.com' }]),
    },
    adminAuditLog: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => audit.push(data)) },
    asset: { findUnique: jest.fn(async ({ where }: { where: { code: string } }) => (['usdt', 'btc'].includes(where.code) ? { code: where.code } : null)) },
  };
  const config = { get: (k: string) => env[k] };
  const passwords = { verify: jest.fn(async (p: string) => p === PASSWORD) };
  const mail = { send: jest.fn(async () => true) };
  const payrep = { account: jest.fn(async (n: string) => ({ accountNumber: n, accountName: 'DAVOCHAIN LTD', status: 'active', balance: '0' })) };
  const svc = new ServerSettingsService(prisma as never, config as never, passwords as never, mail as never, { get: () => payrep } as never);
  return { svc, prisma, flags, audit, passwords, mail, payrep };
}

describe('reading a setting', () => {
  it('nothing set on the dashboard: the .env value applies (nothing changes on the day this ships)', async () => {
    const { svc } = build({ NGN_DEPOSITS_ENABLED: false, QUOTE_TTL_SECONDS: 12 });
    await svc.refresh();
    expect(svc.get('NGN_DEPOSITS_ENABLED')).toBe(false);
    expect(svc.get('QUOTE_TTL_SECONDS')).toBe(12);
  });

  it('a dashboard value wins over .env, on this server at once', async () => {
    const { svc } = build({ NGN_DEPOSITS_ENABLED: false });
    await svc.set(OWNER, 'NGN_DEPOSITS_ENABLED', true, PASSWORD, REASON);
    expect(svc.get('NGN_DEPOSITS_ENABLED')).toBe(true);
  });

  it('another server picks it up on its next refresh (the 30-second snapshot)', async () => {
    const a = build({ NGN_DEPOSITS_ENABLED: false });
    const b = new ServerSettingsService(a.prisma as never, { get: () => false } as never, a.passwords as never, a.mail as never, { get: () => null } as never);
    await b.refresh();
    await a.svc.set(OWNER, 'NGN_DEPOSITS_ENABLED', true, PASSWORD, REASON);
    expect(b.get('NGN_DEPOSITS_ENABLED')).toBe(false);
    await b.refresh();
    expect(b.get('NGN_DEPOSITS_ENABLED')).toBe(true);
  });

  it('a stored value that is no longer valid is ignored (the .env value applies)', async () => {
    const { svc, flags } = build({ QUOTE_TTL_SECONDS: 12 });
    flags.set(SERVER_SETTINGS_FLAG, { value: { QUOTE_TTL_SECONDS: 'banana' } });
    await svc.refresh();
    expect(svc.get('QUOTE_TTL_SECONDS')).toBe(12);
  });

  it('keys that are not on the list are read straight from .env', async () => {
    const { svc } = build({ DATABASE_URL: 'postgres://x' });
    expect(svc.get('DATABASE_URL' as never)).toBe('postgres://x');
  });
});

describe('changing a setting: owners only, password, reason, checked, audited', () => {
  it('a sub-admin is refused', async () => {
    const { svc } = build();
    await expect(svc.set(SUB, 'NGN_DEPOSITS_ENABLED', true, PASSWORD, REASON)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a wrong password is refused and nothing is saved', async () => {
    const { svc, flags } = build();
    await expect(svc.set(OWNER, 'NGN_DEPOSITS_ENABLED', true, 'wrong', REASON)).rejects.toThrow('That password is not correct.');
    expect(flags.size).toBe(0);
  });

  it('a short reason is refused', async () => {
    const { svc } = build();
    await expect(svc.set(OWNER, 'NGN_DEPOSITS_ENABLED', true, PASSWORD, 'because')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an unknown setting, or one that must stay in .env, is refused', async () => {
    const { svc } = build();
    await expect(svc.set(OWNER, 'DATABASE_URL' as never, 'x', PASSWORD, REASON)).rejects.toThrow(/can't be changed here/);
    await expect(svc.set(OWNER, 'JWT_SECRET' as never, 'x', PASSWORD, REASON)).rejects.toThrow(/can't be changed here/);
  });

  it.each([
    ['NGN_DEPOSITS_ENABLED', 'yes'],
    ['QUOTE_TTL_SECONDS', 0],
    ['QUOTE_TTL_SECONDS', 3.5],
    ['PAYREP_MAIN_ACCOUNT', '12345'],
    ['JWT_EXPIRES_IN', '7d'],
    ['JWT_REFRESH_EXPIRES_IN', '3h'],
    ['ADMIN_IDLE_TIMEOUT_MINUTES', 0],
    ['DAILY_DIGEST_HOUR', 24],
    ['DIGEST_TIMEZONE', 'Mars/Olympus'],
    ['SMTP_PORT', 70000],
    ['FEE_CLAIM_DESTINATION', 'dogecoin-not-listed'],
    ['R2_BUCKET', 'https://x.r2.dev/bucket'],
  ])('%s = %p is refused with a clear message', async (key, value) => {
    const { svc, flags } = build({ QUOTE_HARD_EXPIRY_SECONDS: 30 });
    await expect(svc.set(OWNER, key as never, value, PASSWORD, REASON)).rejects.toBeInstanceOf(BadRequestException);
    expect(flags.size).toBe(0);
  });

  it('a quote may not live longer than its hard expiry (the two are checked together)', async () => {
    const { svc } = build({ QUOTE_TTL_SECONDS: 12, QUOTE_HARD_EXPIRY_SECONDS: 10 });
    await svc.refresh();
    await expect(svc.set(OWNER, 'QUOTE_TTL_SECONDS', 12, PASSWORD, REASON)).rejects.toThrow(/hard expiry/);
    await svc.set(OWNER, 'QUOTE_TTL_SECONDS', 8, PASSWORD, REASON);
    expect(svc.get('QUOTE_TTL_SECONDS')).toBe(8);
  });

  it('a quote lifetime of 15 seconds or more is refused, as at start-up: a Quidax swap quotation expires at 15 s', async () => {
    const { svc, flags } = build({ QUOTE_TTL_SECONDS: 12, QUOTE_HARD_EXPIRY_SECONDS: 30 });
    await svc.refresh();
    await expect(svc.set(OWNER, 'QUOTE_TTL_SECONDS', 15, PASSWORD, REASON)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.set(OWNER, 'QUOTE_TTL_SECONDS', 20, PASSWORD, REASON)).rejects.toBeInstanceOf(BadRequestException);
    expect(flags.size).toBe(0);
    await svc.set(OWNER, 'QUOTE_TTL_SECONDS', 14, PASSWORD, REASON);
    expect(svc.get('QUOTE_TTL_SECONDS')).toBe(14);
  });

  it('the main Payrep account must be one Payrep recognises', async () => {
    const { svc, payrep } = build();
    payrep.account.mockRejectedValueOnce(new Error('Account not found'));
    await expect(svc.set(OWNER, 'PAYREP_MAIN_ACCOUNT', '7801234567', PASSWORD, REASON)).rejects.toThrow(/Payrep doesn't recognise/);
    await svc.set(OWNER, 'PAYREP_MAIN_ACCOUNT', '7801234567', PASSWORD, REASON);
    expect(svc.get('PAYREP_MAIN_ACCOUNT')).toBe('7801234567');
  });

  it('the fee destination must be a coin we list', async () => {
    const { svc } = build();
    await svc.set(OWNER, 'FEE_CLAIM_DESTINATION', 'BTC', PASSWORD, REASON);
    expect(svc.get('FEE_CLAIM_DESTINATION')).toBe('btc');
  });

  it('writes an audit row with before, after and the reason', async () => {
    const { svc, audit } = build({ NGN_DEPOSITS_ENABLED: false });
    await svc.refresh();
    await svc.set(OWNER, 'NGN_DEPOSITS_ENABLED', true, PASSWORD, REASON);
    expect(audit).toEqual([
      expect.objectContaining({
        adminUserId: OWNER.id,
        action: 'server_setting.set',
        entity: 'ServerSetting',
        entityId: 'NGN_DEPOSITS_ENABLED',
        before: { value: false, source: 'server' },
        after: { value: true, source: 'dashboard', reason: REASON },
      }),
    ]);
  });

  it('money-related settings email every owner; others do not', async () => {
    const { svc, mail } = build();
    await svc.set(OWNER, 'NGN_DEPOSITS_ENABLED', true, PASSWORD, REASON);
    expect(mail.send).toHaveBeenCalledTimes(2);
    expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@davochain.com', subject: expect.stringMatching(/Naira deposits/) }));
    mail.send.mockClear();
    await svc.set(OWNER, 'DAILY_DIGEST_HOUR', 8, PASSWORD, REASON);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('reset goes back to the .env value, audited', async () => {
    const { svc, audit } = build({ QUOTE_TTL_SECONDS: 12, QUOTE_HARD_EXPIRY_SECONDS: 30 });
    await svc.set(OWNER, 'QUOTE_TTL_SECONDS', 10, PASSWORD, REASON);
    await svc.reset(OWNER, 'QUOTE_TTL_SECONDS', PASSWORD, 'Back to the normal quote time');
    expect(svc.get('QUOTE_TTL_SECONDS')).toBe(12);
    expect(audit.at(-1)).toMatchObject({ action: 'server_setting.reset', entityId: 'QUOTE_TTL_SECONDS' });
  });
});

describe('the screen', () => {
  it('lists every setting with group, value, source and whether it applies live; secrets are never in it', async () => {
    const { svc } = build({ NGN_DEPOSITS_ENABLED: false, SMTP_HOST: 'smtp.example.com' });
    await svc.set(OWNER, 'NGN_DEPOSITS_ENABLED', true, PASSWORD, REASON);
    const view = svc.view();
    const deposits = view.find((s) => s.key === 'NGN_DEPOSITS_ENABLED')!;
    expect(deposits).toMatchObject({ group: 'Naira', value: true, source: 'dashboard', serverDefault: false, live: true, money: true });
    expect(view.find((s) => s.key === 'SMTP_HOST')).toMatchObject({ value: 'smtp.example.com', source: 'server' });
    expect(view.find((s) => s.key === 'FCM_PROJECT_ID')).toMatchObject({ live: false });
    expect(view.map((s) => s.key)).toEqual(SERVER_SETTINGS.map((s) => s.key));
    expect(JSON.stringify(view)).not.toMatch(/PASSWORD|SECRET_KEY|PRIVATE_KEY|JWT_SECRET/);
  });
});
