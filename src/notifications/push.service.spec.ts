import { PushService } from './push.service';

/** One message to many phones: a broadcast wave (29 Oct 2026). */
function build(fail: (token: string) => string | null = () => null) {
  const prisma = { deviceToken: { updateMany: jest.fn(async () => ({ count: 1 })) } };
  const svc = new PushService(prisma as never, {} as never, {} as never);
  const calls: string[][] = [];
  (svc as any).messaging = {
    sendEachForMulticast: jest.fn(async ({ tokens }: { tokens: string[] }) => {
      calls.push(tokens);
      const responses = tokens.map((t) => (fail(t) ? { success: false, error: { code: fail(t)!, message: 'x' } } : { success: true }));
      return { successCount: responses.filter((r) => r.success).length, failureCount: responses.filter((r) => !r.success).length, responses };
    }),
  };
  return { svc, prisma, calls };
}

describe('PushService.sendToTokens', () => {
  it('sends in groups of at most 500 phones, the most Firebase takes in one call', async () => {
    const { svc, calls } = build();
    const tokens = Array.from({ length: 1201 }, (_, i) => `t${i}`);
    await expect(svc.sendToTokens(tokens, { title: 'T', body: 'B', data: { broadcastId: 'b1' } })).resolves.toEqual({ sent: 1201, failed: 0 });
    expect(calls.map((c) => c.length)).toEqual([500, 500, 201]);
  });

  it('counts failures and switches off phones Firebase says are gone', async () => {
    const { svc, prisma } = build((t) => (t === 'dead' ? 'messaging/registration-token-not-registered' : t === 'busy' ? 'messaging/internal-error' : null));
    await expect(svc.sendToTokens(['ok', 'dead', 'busy'], { title: 'T', body: 'B' })).resolves.toEqual({ sent: 1, failed: 2 });
    expect(prisma.deviceToken.updateMany).toHaveBeenCalledWith({ where: { token: { in: ['dead'] } }, data: { disabledAt: expect.any(Date) } });
  });

  it('push switched off (no Firebase keys) or no phones: nothing sent, nothing failed', async () => {
    const { svc } = build();
    await expect(svc.sendToTokens([], { title: 'T', body: 'B' })).resolves.toEqual({ sent: 0, failed: 0 });
    (svc as any).messaging = null;
    await expect(svc.sendToTokens(['a'], { title: 'T', body: 'B' })).resolves.toEqual({ sent: 0, failed: 0 });
  });
});
