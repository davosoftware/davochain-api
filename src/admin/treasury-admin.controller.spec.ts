import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TreasuryAdminController } from './treasury-admin.controller';
import { PERMISSIONS_KEY } from './require-permissions.decorator';
import { TreasuryMoveDto, TreasurySettingsDto } from './dto';

const perms = (name: string) => Reflect.getMetadata(PERMISSIONS_KEY, (TreasuryAdminController.prototype as unknown as Record<string, () => void>)[name]);

describe('Treasury admin routes', () => {
  it('reading needs treasury.view; changing needs treasury.manage (and the service still demands an owner)', () => {
    expect(perms('snapshot')).toEqual(['treasury.view']);
    expect(perms('banks')).toEqual(['treasury.view']);
    expect(perms('saveSettings')).toEqual(['treasury.manage']);
    expect(perms('checkName')).toEqual(['treasury.manage']);
    expect(perms('sendToQuidax')).toEqual(['treasury.manage']);
    expect(perms('checkMove')).toEqual(['treasury.manage']);
  });

  it('a move needs an amount and the password; settings need the password', async () => {
    expect((await validate(plainToInstance(TreasuryMoveDto, { amount: 1000 }))).map((e) => e.property)).toEqual(['password']);
    expect((await validate(plainToInstance(TreasurySettingsDto, { payoutReserveNgn: 100 }))).map((e) => e.property)).toEqual(['password']);
  });

  it('every owner action is audited, never with the password', async () => {
    const audit = jest.fn(async () => undefined);
    const treasury = {
      saveSettings: jest.fn(async () => ({ before: { payoutReserveNgn: '0' }, after: { payoutReserveNgn: '5' } })),
      sendToQuidax: jest.fn(async () => ({ moveId: 'm1', reference: 'trsy_1', status: 'SENDING', reason: null })),
      snapshot: jest.fn(async () => ({})),
    };
    const c = new TreasuryAdminController(treasury as never, { audit } as never);
    const actor = { sub: 'owner-1', role: 'OWNER' } as never;
    await c.saveSettings(actor, { payoutReserveNgn: 5, password: 'secret-pw' } as never, { ip: '1.2.3.4' } as never);
    await c.sendToQuidax(actor, { amount: 1000, password: 'secret-pw' } as never, { ip: '1.2.3.4' } as never);
    expect(audit).toHaveBeenCalledWith('owner-1', 'treasury.settings', 'TreasurySettings', 'default', expect.anything(), expect.anything(), '1.2.3.4');
    expect(audit).toHaveBeenCalledWith('owner-1', 'treasury.move', 'TreasuryMove', 'm1', null, expect.objectContaining({ amount: 1000, reference: 'trsy_1' }), '1.2.3.4');
    expect(JSON.stringify(audit.mock.calls)).not.toContain('secret-pw');
  });
});

describe('Treasury "mark as failed" route', () => {
  it('needs treasury.manage, is audited with before and after, never with the password', async () => {
    expect(perms('markFailed')).toEqual(['treasury.manage']);
    const audit = jest.fn(async () => undefined);
    const treasury = {
      markFailed: jest.fn(async () => ({ before: { status: 'SENDING' }, after: { status: 'FAILED' } })),
      snapshot: jest.fn(async () => ({})),
    };
    const c = new TreasuryAdminController(treasury as never, { audit } as never);
    await c.markFailed({ sub: 'owner-1', role: 'OWNER' } as never, 'm1', { password: 'secret-pw' } as never, { ip: '1.2.3.4' } as never);
    expect(audit).toHaveBeenCalledWith('owner-1', 'treasury.move.mark_failed', 'TreasuryMove', 'm1', { status: 'SENDING' }, { status: 'FAILED' }, '1.2.3.4');
    expect(JSON.stringify(audit.mock.calls)).not.toContain('secret-pw');
  });
});
