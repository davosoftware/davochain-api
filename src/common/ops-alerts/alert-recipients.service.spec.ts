import { AlertType } from '@prisma/client';
import { FakePrisma } from '../../ngn-deposits/testing/fake-prisma';
import { AlertRecipientsService, SECURITY_ALERT_TYPES } from './alert-recipients.service';

function setup(defaults: string[] | null = ['ops@davochain.test']) {
  const db = new FakePrisma();
  const config = { get: (k: string) => (k === 'ALERT_DEFAULT_RECIPIENTS' ? (defaults ?? undefined) : undefined) };
  return { db, svc: new AlertRecipientsService(db as never, config as never) };
}

describe('AlertRecipientsService.resolve: who an alert goes to', () => {
  it('sends to the enabled recipients set for the type', async () => {
    const { db, svc } = setup();
    await db.alertRecipient.create({ data: { type: 'ADMIN_LOCKOUT', email: 'sec@davochain.test' } });
    await db.alertRecipient.create({ data: { type: 'ADMIN_LOCKOUT', email: 'cto@davochain.test' } });
    await expect(svc.resolve(AlertType.ADMIN_LOCKOUT)).resolves.toEqual(['sec@davochain.test', 'cto@davochain.test']);
  });

  it('ignores disabled recipients', async () => {
    const { db, svc } = setup();
    await db.alertRecipient.create({ data: { type: 'ADMIN_LOCKOUT', email: 'on@davochain.test' } });
    await db.alertRecipient.create({ data: { type: 'ADMIN_LOCKOUT', email: 'off@davochain.test', enabled: false } });
    await expect(svc.resolve(AlertType.ADMIN_LOCKOUT)).resolves.toEqual(['on@davochain.test']);
  });

  it('falls back to ALERT_DEFAULT_RECIPIENTS when the type has no enabled recipient', async () => {
    const { db, svc } = setup(['ops@davochain.test']);
    await db.alertRecipient.create({ data: { type: 'ADMIN_LOCKOUT', email: 'off@davochain.test', enabled: false } });
    await expect(svc.resolve(AlertType.ADMIN_LOCKOUT)).resolves.toEqual(['ops@davochain.test']);
    await expect(svc.resolve(AlertType.PRICE_DIP)).resolves.toEqual(['ops@davochain.test']);
  });

  it('is empty when neither is set, so callers can log that nobody was told', async () => {
    const { svc } = setup(null);
    await expect(svc.resolve(AlertType.RATE_LIMIT_DEGRADED)).resolves.toEqual([]);
  });

  it('treats lockouts, rate-limit outages and Dojah/AML alerts as security alerts', () => {
    expect([...SECURITY_ALERT_TYPES].sort()).toEqual(['ADMIN_LOCKOUT', 'AML_REVIEW', 'AML_SANCTIONS', 'DOJAH_CONFIG', 'RATE_LIMIT_DEGRADED']);
  });
});

/** FakePrisma plus the advisory-lock call the real service makes inside its transaction. */
function managed(defaults: string[] | null = ['ops@davochain.test']) {
  const { db, svc } = setup(defaults);
  const locks: string[] = [];
  Object.assign(db, {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      locks.push(String(values[0]));
      return [{ ok: 1 }];
    }),
  });
  return { db, svc, locks };
}

describe('AlertRecipientsService: managing recipients', () => {
  it('adds a recipient, normalising the email, under a lock for that alert type', async () => {
    const { svc, locks } = managed();
    const row = await svc.add(AlertType.ADMIN_LOCKOUT, '  Sec@DavoChain.test ');
    expect(row).toMatchObject({ type: 'ADMIN_LOCKOUT', email: 'sec@davochain.test', enabled: true });
    expect(locks).toEqual(['alert_recipients:ADMIN_LOCKOUT']);
  });

  it('refuses the same email twice for a type with 409', async () => {
    const { svc } = managed();
    await svc.add(AlertType.PRICE_DIP, 'ops@davochain.test');
    await expect(svc.add(AlertType.PRICE_DIP, 'OPS@davochain.test')).rejects.toMatchObject({ status: 409 });
  });

  it('will not disable or remove the last enabled recipient of a security alert', async () => {
    const { svc } = managed();
    const only = await svc.add(AlertType.ADMIN_LOCKOUT, 'sec@davochain.test');
    await expect(svc.setEnabled(only.id, false)).rejects.toMatchObject({
      status: 409,
      message: 'This is the last enabled recipient of a security alert. Add another first.',
    });
    await expect(svc.remove(only.id)).rejects.toMatchObject({ status: 409 });
    const second = await svc.add(AlertType.ADMIN_LOCKOUT, 'cto@davochain.test');
    await expect(svc.remove(only.id)).resolves.toMatchObject({ id: only.id });
    await expect(svc.setEnabled(second.id, false)).rejects.toMatchObject({ status: 409 });
  });

  it('lets an ordinary alert lose its last recipient: it falls back to the environment', async () => {
    const { svc } = managed();
    const only = await svc.add(AlertType.PRICE_DIP, 'ops2@davochain.test');
    await expect(svc.setEnabled(only.id, false)).resolves.toMatchObject({ after: { enabled: false } });
    await expect(svc.resolve(AlertType.PRICE_DIP)).resolves.toEqual(['ops@davochain.test']);
  });

  it('removing or toggling a recipient that does not exist is a 404', async () => {
    const { svc } = managed();
    await expect(svc.remove('nope')).rejects.toMatchObject({ status: 404 });
    await expect(svc.setEnabled('nope', true)).rejects.toMatchObject({ status: 404 });
  });

  it('lists every alert type with its description, security flag and whether it is on the env fallback', async () => {
    const { svc } = managed();
    await svc.add(AlertType.ADMIN_LOCKOUT, 'sec@davochain.test');
    const view = await svc.list();
    expect(view.types.map((t) => t.type)).toEqual(Object.values(AlertType));
    const lockout = view.types.find((t) => t.type === 'ADMIN_LOCKOUT')!;
    expect(lockout).toMatchObject({ security: true, usingEnvFallback: false });
    expect(lockout.recipients.map((r) => r.email)).toEqual(['sec@davochain.test']);
    expect(view.types.find((t) => t.type === 'PRICE_DIP')).toMatchObject({ security: false, usingEnvFallback: true });
    for (const t of view.types) expect(t.description.length).toBeGreaterThan(10);
  });
});

describe('AlertRecipientsService: audit and fallback honesty (final review)', () => {
  const actor = { adminId: 'admin-1', ip: '203.0.113.5' };

  it('writes the audit row inside the same transaction as the change', async () => {
    const { db, svc } = managed();
    const row = await svc.add(AlertType.PRICE_DIP, 'ops3@davochain.test', actor);
    await svc.setEnabled(row.id, false, actor);
    await svc.remove(row.id, actor);
    const audits = db.rows('adminAuditLog').map((a) => `${a.action}:${a.entityId}:${a.ip}`);
    expect(audits).toEqual([
      `alert_recipient.add:${row.id}:203.0.113.5`,
      `alert_recipient.disable:${row.id}:203.0.113.5`,
      `alert_recipient.remove:${row.id}:203.0.113.5`,
    ]);
  });

  it('rolls the change back when its audit row cannot be written', async () => {
    const { db, svc } = managed();
    jest.spyOn(db.adminAuditLog, 'create').mockRejectedValueOnce(new Error('audit table unavailable'));
    await expect(svc.add(AlertType.PRICE_DIP, 'ops4@davochain.test', actor)).rejects.toThrow('audit table unavailable');
    expect(db.rows('alertRecipient')).toHaveLength(0);
  });

  it('says whether the env fallback actually names anyone, so "server default" never hides "nobody"', async () => {
    expect((await managed(['ops@davochain.test']).svc.list()).fallbackConfigured).toBe(true);
    expect((await managed(null).svc.list()).fallbackConfigured).toBe(false);
    expect((await managed([]).svc.list()).fallbackConfigured).toBe(false);
  });
});

it('treats the three Dojah/AML types as security alerts', () => {
  for (const t of ['DOJAH_CONFIG', 'AML_REVIEW', 'AML_SANCTIONS'] as const) expect(SECURITY_ALERT_TYPES.has(t)).toBe(true);
});
