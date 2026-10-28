import { PushService } from './push.service';

/**
 * A broadcast wave (29 Oct 2026): many phones, each with its own message, so
 * every push carries that customer's own notificationId. 500 per call.
 */
function build(fail: (token: string) => string | null = () => null) {
  const prisma = { deviceToken: { updateMany: jest.fn(async () => ({ count: 1 })) } };
  const svc = new PushService(prisma as never, {} as never, {} as never);
  const calls: Array<Array<{ token: string; data?: Record<string, string>; notification: { title: string } }>> = [];
  (svc as any).messaging = {
    sendEach: jest.fn(async (messages: Array<{ token: string }>) => {
      calls.push(messages as never);
      const responses = messages.map((m) => (fail(m.token) ? { success: false, error: { code: fail(m.token)!, message: 'x' } } : { success: true }));
      return { successCount: responses.filter((r) => r.success).length, failureCount: responses.filter((r) => !r.success).length, responses };
    }),
  };
  return { svc, prisma, calls };
}

const msg = (token: string, notificationId = `n-${token}`) => ({ token, title: 'T', body: 'B', data: { type: 'admin.broadcast.b1', broadcastId: 'b1', notificationId } });

describe('PushService.sendMessages', () => {
  it('each phone gets its own data, in calls of at most 500', async () => {
    const { svc, calls } = build();
    const messages = Array.from({ length: 1201 }, (_, i) => msg(`t${i}`));
    await expect(svc.sendMessages(messages)).resolves.toEqual({ sent: 1201, failed: 0 });
    expect(calls.map((c) => c.length)).toEqual([500, 500, 201]);
    expect(calls[0][7]).toMatchObject({ token: 't7', notification: { title: 'T', body: 'B' }, data: { notificationId: 'n-t7', broadcastId: 'b1' } });
  });

  it('counts failures and switches off phones Firebase says are gone', async () => {
    const { svc, prisma } = build((t) => (t === 'dead' ? 'messaging/registration-token-not-registered' : t === 'busy' ? 'messaging/internal-error' : null));
    await expect(svc.sendMessages([msg('ok'), msg('dead'), msg('busy')])).resolves.toEqual({ sent: 1, failed: 2 });
    expect(prisma.deviceToken.updateMany).toHaveBeenCalledWith({ where: { token: { in: ['dead'] } }, data: { disabledAt: expect.any(Date) } });
  });

  it('push switched off (no Firebase keys) or no phones: nothing sent, nothing failed', async () => {
    const { svc } = build();
    await expect(svc.sendMessages([])).resolves.toEqual({ sent: 0, failed: 0 });
    (svc as any).messaging = null;
    await expect(svc.sendMessages([msg('a')])).resolves.toEqual({ sent: 0, failed: 0 });
  });
});
