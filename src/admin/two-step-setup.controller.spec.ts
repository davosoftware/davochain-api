import { AdminAuthController } from './admin.controller';

/** C8: the backup-code file made after a required-two-step sign-in names the admin's real email, not the masked one. */
describe('POST admin/auth/login/setup', () => {
  it('returns the admin\'s own email with the backup codes', async () => {
    const c = Object.create(AdminAuthController.prototype) as AdminAuthController;
    Object.assign(c, {
      twoStep: { completeSetup: jest.fn(async () => ({ admin: { id: 'a1', email: 'ada@davochain.test' }, backupCodes: ['1111-2222'] })) },
      admin: { signToken: jest.fn(async () => 'tok'), audit: jest.fn(async () => undefined) },
    });
    const r = await c.completeTwoStepSetup({ ticket: 't', code: '123456' } as never, { ip: '1.2.3.4', headers: {} } as never);
    expect(r).toEqual({ accessToken: 'tok', backupCodes: ['1111-2222'], email: 'ada@davochain.test' });
  });
});
