import { Logger } from '@nestjs/common';
import { AlertType } from '@prisma/client';
import { FakePrisma } from '../../ngn-deposits/testing/fake-prisma';
import { OpsAlertsService } from './ops-alerts.service';

function setup(defaults: string[] = ['ops@davochain.test']) {
  const db = new FakePrisma();
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const mail = {
    send: jest.fn(async (m: { to: string; subject: string; text: string }) => {
      sent.push(m);
      return true;
    }),
  };
  const config = { get: (k: string) => (k === 'ALERT_DEFAULT_RECIPIENTS' ? defaults : undefined) };
  return { db, sent, svc: new OpsAlertsService(db as never, config as never, mail as never) };
}

describe('OpsAlertsService', () => {
  it('records the alert and emails the default recipients', async () => {
    const { db, sent, svc } = setup();
    await expect(svc.raise(AlertType.NGN_DEPOSIT_UNMATCHED, 'unmatched:1', 'Unmatched deposit', ['Flutterwave id 1'])).resolves.toBe(true);
    expect(db.rows('alert')).toHaveLength(1);
    expect(db.rows('alert')[0]).toMatchObject({ type: 'NGN_DEPOSIT_UNMATCHED', assetCode: 'unmatched:1' });
    expect(sent).toEqual([expect.objectContaining({ to: 'ops@davochain.test', subject: '[DavoChain] Unmatched deposit' })]);
  });

  it('prefers the recipients configured for the alert type', async () => {
    const { db, sent, svc } = setup();
    await db.alertRecipient.create({ data: { type: 'FLUTTERWAVE_CONFIG', email: 'cto@davochain.test' } });
    await svc.raise(AlertType.FLUTTERWAVE_CONFIG, 'config', 'Key refused', []);
    expect(sent.map((m) => m.to)).toEqual(['cto@davochain.test']);
  });

  it('stays quiet inside the cooldown for the same type and key', async () => {
    const { sent, svc } = setup();
    await svc.raise(AlertType.FLUTTERWAVE_CONFIG, 'config', 'Key refused', []);
    await expect(svc.raise(AlertType.FLUTTERWAVE_CONFIG, 'config', 'Key refused', [])).resolves.toBe(false);
    await svc.raise(AlertType.FLUTTERWAVE_CONFIG, 'other-key', 'Something else', []);
    expect(sent).toHaveLength(2);
  });

  it('redacts 11-digit numbers from the subject, the lines and the stored payload', async () => {
    const { db, sent, svc } = setup();
    await svc.raise(AlertType.NGN_RECONCILIATION, 'k', 'BVN 22222223883 problem', ['nin 12345678901']);
    expect(JSON.stringify(db.rows('alert'))).not.toMatch(/22222223883|12345678901/);
    expect(JSON.stringify(sent)).not.toMatch(/22222223883|12345678901/);
  });

  it('never throws, even when the database fails', async () => {
    const { db, svc } = setup();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      db.failNext('alert', 'findFirst', new Error('db down'));
      await expect(svc.raise(AlertType.NGN_RECONCILIATION, 'k', 's', [])).resolves.toBe(false);
    } finally {
      error.mockRestore();
    }
  });
});
