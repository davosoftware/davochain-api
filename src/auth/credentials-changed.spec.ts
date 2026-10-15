import { AuthService } from './auth.service';

describe('A password change starts the withdrawal cool-off clock', () => {
  it.each(['changePassword', 'resetPassword'])('%s sets credentialsChangedAt', async (method) => {
    const writes: Array<Record<string, unknown>> = [];
    const svc = Object.create(AuthService.prototype) as Record<string, unknown>;
    Object.assign(svc, {
      prisma: {
        user: {
          findUnique: jest.fn(async () => ({ id: 'u1', passwordHash: 'h', status: 'ACTIVE', email: 'a@x' })),
          findUniqueOrThrow: jest.fn(async () => ({ id: 'u1', passwordHash: 'h', status: 'ACTIVE', email: 'a@x' })),
          update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => (writes.push(data), {})),
        },
        refreshToken: { updateMany: jest.fn(async () => ({ count: 0 })) },
      },
      passwords: { verify: jest.fn(async () => method === 'changePassword'), hash: jest.fn(async () => 'h2') },
      otps: { consume: jest.fn(async () => undefined) },
      mail: { send: jest.fn(async () => undefined) },
      log: { warn: jest.fn(), log: jest.fn() },
    });
    const call = method === 'changePassword'
      ? (svc.changePassword as (...a: unknown[]) => Promise<unknown>).call(svc, 'u1', 'Old-pass-123', 'New-pass-456')
      : (svc.resetPassword as (...a: unknown[]) => Promise<unknown>).call(svc, 'a@x', '123456', 'New-pass-456');
    await call.catch(() => undefined);
    expect(writes.some((w) => w.credentialsChangedAt instanceof Date)).toBe(true);
  });
});
