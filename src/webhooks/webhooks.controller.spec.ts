import { WebhooksController } from './webhooks.controller';

function setup(valid: boolean) {
  const created: Array<{ data: Record<string, unknown> }> = [];
  const prisma = {
    webhookEvent: {
      create: jest.fn(async (arg: { data: Record<string, unknown> }) => {
        created.push(arg);
        return { id: 'evt-1' };
      }),
    },
  };
  const signature = { verify: jest.fn(async () => valid) };
  const queue = { add: jest.fn(async () => undefined) };
  const ctl = new WebhooksController(prisma as never, signature as never, queue as never);
  const body = { event: 'deposit.successful', data: { id: 'q-1', user: { email: 'leak@example.com' } } };
  const raw = Buffer.from(JSON.stringify(body));
  const call = () => ctl.receive({ rawBody: raw, body } as never, 't=1,s=x');
  return { created, queue, call, raw };
}

describe('WebhooksController (Quidax)', () => {
  it('records a bad-signature request by size and reason only, never its body', async () => {
    const { created, queue, call, raw } = setup(false);
    await expect(call()).resolves.toEqual({ received: true });
    expect(created).toHaveLength(1);
    expect(created[0].data).toMatchObject({ signatureValid: false, eventName: 'deposit.successful' });
    expect(created[0].data.payload).toEqual({ bytes: raw.length, reason: 'bad-signature', json: true });
    expect(JSON.stringify(created[0].data)).not.toContain('leak@example.com');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('still stores and queues a genuine event in full', async () => {
    const { created, queue, call } = setup(true);
    await call();
    expect(created[0].data).toMatchObject({ signatureValid: true });
    expect(JSON.stringify(created[0].data.payload)).toContain('q-1');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});
