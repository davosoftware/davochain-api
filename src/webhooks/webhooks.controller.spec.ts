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
  it('refuses a bad-signature request with 401, recording it by size and reason only (H5)', async () => {
    const { created, queue, call, raw } = setup(false);
    await expect(call()).rejects.toMatchObject({ status: 401 });
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

describe('WebhooksController: attacker-supplied event names (final review m5)', () => {
  function badCall(event: string) {
    const created: Array<{ data: Record<string, unknown> }> = [];
    const prisma = { webhookEvent: { create: jest.fn(async (arg: { data: Record<string, unknown> }) => (created.push(arg), { id: 'e' })) } };
    const ctl = new WebhooksController(prisma as never, { verify: jest.fn(async () => false) } as never, { add: jest.fn() } as never);
    const body = { event, data: { id: 'q' } };
    return ctl
      .receive({ rawBody: Buffer.from(JSON.stringify(body)), body } as never, 'bad')
      .catch(() => undefined)
      .then(() => created[0].data.eventName);
  }

  it('keeps a plain event name for a bad-signature request', async () => {
    await expect(badCall('deposit.successful')).resolves.toBe('deposit.successful');
  });

  it('replaces anything else with "unknown", so no attacker text is stored or logged', async () => {
    await expect(badCall('x'.repeat(65))).resolves.toBe('unknown');
    await expect(badCall('<script>alert(1)</script>')).resolves.toBe('unknown');
    await expect(badCall('leak@example.com')).resolves.toBe('unknown');
  });
});

describe('WebhooksController: a genuine event is never lost (H5)', () => {
  function genuine(opts: { queueDown?: boolean; duplicateOf?: { id: string; processedAt: Date | null } } = {}) {
    const prisma = {
      webhookEvent: {
        create: jest.fn(async () => {
          if (opts.duplicateOf) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
          return { id: 'evt-1' };
        }),
        findUnique: jest.fn(async () => opts.duplicateOf ?? null),
      },
    };
    const queue = {
      add: jest.fn(async () => {
        if (opts.queueDown) throw new Error('Redis connection refused');
      }),
    };
    const ctl = new WebhooksController(prisma as never, { verify: jest.fn(async () => true) } as never, queue as never);
    const body = { event: 'deposit.successful', data: { id: 'q-1' } };
    const call = () => ctl.receive({ rawBody: Buffer.from(JSON.stringify(body)), body } as never, 'sig');
    return { prisma, queue, call };
  }

  it('Redis down: the event is stored and Quidax still gets 200, so the re-drive job can pick it up', async () => {
    const { prisma, call } = genuine({ queueDown: true });
    await expect(call()).resolves.toEqual({ received: true });
    expect(prisma.webhookEvent.create).toHaveBeenCalled();
  });

  it('a repeat delivery of a stored but unprocessed event queues it again', async () => {
    const { queue, call } = genuine({ duplicateOf: { id: 'evt-1', processedAt: null } });
    await call();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('a repeat delivery of an event already processed is ignored', async () => {
    const { queue, call } = genuine({ duplicateOf: { id: 'evt-1', processedAt: new Date() } });
    await call();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
