import { AdminController } from './admin.controller';

/**
 * M7 (PROJECT_REVIEW): admin "Sign out" only deleted the browser cookie; the
 * session stayed valid on the server until it idled out. There is now a
 * logout route that ends this session (only this one) and is audited.
 */
describe('M7: admin logout ends the session on the server', () => {
  it('revokes the current session by its jti and records it', async () => {
    const ctl = Object.create(AdminController.prototype) as AdminController & Record<string, unknown>;
    const revoke = jest.fn(async () => undefined);
    const audit = jest.fn(async () => undefined);
    Object.assign(ctl, { sessions: { revoke }, admin: { audit } });
    await (ctl as unknown as { logout: (a: unknown) => Promise<unknown> }).logout({ sub: 'a1', jti: 'session-123', role: 'OWNER', typ: 'admin', email: 'a@x' });
    expect(revoke).toHaveBeenCalledWith('session-123', 'signed out');
    expect(audit).toHaveBeenCalledWith('a1', 'admin.logout', 'AdminUser', 'a1', null, null);
  });
});
