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

  it('treats lockouts and rate-limit outages as security alerts', () => {
    expect([...SECURITY_ALERT_TYPES].sort()).toEqual(['ADMIN_LOCKOUT', 'RATE_LIMIT_DEGRADED']);
  });
});
