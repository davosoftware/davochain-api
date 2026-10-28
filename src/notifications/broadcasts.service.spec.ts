import { BroadcastsService } from './broadcasts.service';

/**
 * Broadcasts sent by a background worker, in waves (decisions 29 Oct 2026):
 * Send only saves and queues; the worker sends N customers per second, push
 * always, email if ticked, and records progress. Pause, resume and cancel.
 */
type B = Record<string, any>;

function build(opts: { broadcast?: B; users?: Array<{ id: string; email: string; firstName: string; emailVerifiedAt: Date | null }>; tokens?: Array<{ userId: string; token: string }>; perSecond?: number; emailsPerSecond?: number } = {}) {
  const b: B = {
    id: 'b1', title: 'Hello', body: 'News', audience: 'ALL', status: 'SENDING', withEmail: false, userIds: [], cursor: null,
    processedCount: 0, recipientCount: 3, createdAt: new Date('2026-10-29T08:00:00Z'), ...opts.broadcast,
  };
  const users = opts.users ?? [
    { id: 'u1', email: 'a@x.y', firstName: 'Ada', emailVerifiedAt: new Date() },
    { id: 'u2', email: 'b@x.y', firstName: 'Bob', emailVerifiedAt: null },
    { id: 'u3', email: 'c@x.y', firstName: 'Cy', emailVerifiedAt: new Date() },
  ];
  const inbox: B[] = [];
  const t = {
    broadcast: {
      updateMany: jest.fn(async ({ where, data }: B) => {
        if (where.status && (where.status.in ? !where.status.in.includes(b.status) : where.status !== b.status)) return { count: 0 };
        if ('cursor' in where && where.cursor !== b.cursor) return { count: 0 };
        for (const [k, v] of Object.entries(data)) b[k] = v && typeof v === 'object' && 'increment' in (v as B) ? (b[k] ?? 0) + (v as B).increment : v;
        return { count: 1 };
      }),
    },
    notification: { createMany: jest.fn(async ({ data }: B) => (inbox.push(...data), { count: data.length })) },
  };
  const prisma = {
    ...t,
    broadcast: {
      ...t.broadcast,
      findUnique: jest.fn(async () => ({ ...b })),
      create: jest.fn(async ({ data }: B) => Object.assign(b, { id: 'b1', ...data })),
      update: jest.fn(async ({ data }: B) => {
        for (const [k, v] of Object.entries(data)) b[k] = v && typeof v === 'object' && 'increment' in (v as B) ? (b[k] ?? 0) + (v as B).increment : v;
        return { ...b };
      }),
    },
    user: {
      count: jest.fn(async () => users.length),
      findMany: jest.fn(async ({ where, take }: B) => users.filter((u) => !where.id?.gt || u.id > where.id.gt).slice(0, take)),
    },
    deviceToken: { findMany: jest.fn(async ({ where }: B) => (opts.tokens ?? []).filter((d) => where.userId.in.includes(d.userId))) },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(t)),
  };
  const push = { sendToTokens: jest.fn(async (tokens: string[]) => ({ sent: tokens.length, failed: 0 })) };
  const mail = { send: jest.fn(async () => undefined) };
  const queue = { add: jest.fn(async () => undefined) };
  const settings = { get: jest.fn((key: string) => (key === 'BROADCAST_EMAILS_PER_SECOND' ? opts.emailsPerSecond ?? 10 : opts.perSecond ?? 100)) };
  const svc = new BroadcastsService(prisma as never, push as never, mail as never, queue as never, settings as never);
  return { svc, b, prisma, push, mail, queue, inbox, settings };
}

describe('queue: Send only saves the message and hands it to the worker', () => {
  it('counts the audience, saves it as QUEUED and adds one job; nothing is sent here', async () => {
    const h = build({ broadcast: { status: undefined } });
    const r = await h.svc.queue({ adminId: 'a1', title: ' Hello ', body: ' News ', withEmail: true });
    expect(r).toMatchObject({ id: 'b1', status: 'QUEUED', recipientCount: 3, withEmail: true });
    expect(h.prisma.broadcast.create.mock.calls[0][0].data).toMatchObject({ title: 'Hello', body: 'News', audience: 'ALL', status: 'QUEUED', withEmail: true, recipientCount: 3 });
    expect(h.queue.add).toHaveBeenCalledWith('run-broadcast', { broadcastId: 'b1' }, expect.objectContaining({ jobId: expect.stringContaining('b1') }));
    expect(h.push.sendToTokens).not.toHaveBeenCalled();
    expect(h.prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it('refuses an empty title, message or audience', async () => {
    await expect(build().svc.queue({ adminId: 'a1', title: ' ', body: 'x' })).rejects.toThrow(/title/);
    await expect(build().svc.queue({ adminId: 'a1', title: 'x', body: '' })).rejects.toThrow(/message/);
    await expect(build({ users: [] }).svc.queue({ adminId: 'a1', title: 'x', body: 'y' })).rejects.toThrow(/No matching/);
  });
});

describe('runWave: one wave of customers', () => {
  it('writes each customer an inbox message, pushes to their phones and moves the cursor', async () => {
    const h = build({ tokens: [{ userId: 'u1', token: 't1' }, { userId: 'u1', token: 't1b' }, { userId: 'u3', token: 't3' }] });
    await expect(h.svc.runWave('b1')).resolves.toBe('continue');
    expect(h.inbox.map((n) => [n.userId, n.channel, n.broadcastId])).toEqual([['u1', 'IN_APP', 'b1'], ['u2', 'IN_APP', 'b1'], ['u3', 'IN_APP', 'b1']]);
    expect(h.push.sendToTokens).toHaveBeenCalledWith(['t1', 't1b', 't3'], expect.objectContaining({ title: 'Hello', body: 'News', data: { type: 'admin.broadcast.b1', broadcastId: 'b1' } }));
    expect(h.b).toMatchObject({ cursor: 'u3', processedCount: 3, pushSentCount: 3, pushFailedCount: 0 });
  });

  it('sends this many customers per wave (the setting)', async () => {
    const h = build({ perSecond: 2 });
    await h.svc.runWave('b1');
    expect(h.b).toMatchObject({ cursor: 'u2', processedCount: 2 });
    await h.svc.runWave('b1');
    expect(h.b).toMatchObject({ cursor: 'u3', processedCount: 3 });
  });

  it('when nothing is left: DONE', async () => {
    const h = build({ broadcast: { cursor: 'u3', processedCount: 3 } });
    await expect(h.svc.runWave('b1')).resolves.toBe('stop');
    expect(h.b.status).toBe('DONE');
    expect(h.b.finishedAt).toBeInstanceOf(Date);
  });

  it('with email ticked: only confirmed addresses, at the email speed, never twice', async () => {
    const h = build({ broadcast: { withEmail: true }, perSecond: 100, emailsPerSecond: 2 });
    await h.svc.runWave('b1');
    expect(h.b.processedCount).toBe(2);
    expect(h.mail.send).toHaveBeenCalledTimes(1);
    expect(h.mail.send).toHaveBeenCalledWith(expect.objectContaining({ key: 'admin.broadcast', to: 'a@x.y', dedupeOn: 'b1:u1', variables: expect.objectContaining({ firstName: 'Ada', title: 'Hello' }) }));
    expect(h.b.emailQueuedCount).toBe(1);
  });

  it("the message is the admin's plain text: tags are shown, not run", async () => {
    const h = build({ broadcast: { withEmail: true, body: '<b>hi</b>\nline 2' } });
    await h.svc.runWave('b1');
    expect((h.mail.send.mock.calls as any)[0][0].variables.message).toBe('&lt;b&gt;hi&lt;/b&gt;<br>line 2');
  });

  it('paused or cancelled: does nothing and stops', async () => {
    for (const status of ['PAUSED', 'CANCELLED', 'DONE']) {
      const h = build({ broadcast: { status } });
      await expect(h.svc.runWave('b1')).resolves.toBe('stop');
      expect(h.inbox).toEqual([]);
      expect(h.push.sendToTokens).not.toHaveBeenCalled();
    }
  });

  it('a wave another worker already took is not sent twice', async () => {
    const h = build();
    // Someone moved the cursor between our read and our claim.
    h.prisma.broadcast.findUnique.mockResolvedValueOnce({ ...h.b, cursor: null });
    h.b.cursor = 'u1';
    await h.svc.runWave('b1');
    expect(h.inbox).toEqual([]);
    expect(h.push.sendToTokens).not.toHaveBeenCalled();
  });

  it('a push failure is counted, never retried into duplicates', async () => {
    const h = build({ tokens: [{ userId: 'u1', token: 't1' }] });
    h.push.sendToTokens.mockRejectedValueOnce(new Error('FCM down'));
    await expect(h.svc.runWave('b1')).resolves.toBe('continue');
    expect(h.b).toMatchObject({ processedCount: 3, pushFailedCount: 1 });
  });

  it('a selected audience: only those customers', async () => {
    const h = build({ broadcast: { audience: 'SELECTED', userIds: ['u2'] } });
    await h.svc.runWave('b1');
    expect(h.prisma.user.findMany.mock.calls[0][0].where).toMatchObject({ id: { in: ['u2'] } });
  });

  it('everyone: active customers who existed when it was sent', async () => {
    const h = build();
    await h.svc.runWave('b1');
    expect(h.prisma.user.findMany.mock.calls[0][0].where).toMatchObject({ status: 'ACTIVE', createdAt: { lte: h.b.createdAt } });
  });
});

describe('run: the worker paces the waves', () => {
  it('starts a QUEUED broadcast, runs waves until DONE, at most one wave a second', async () => {
    jest.useFakeTimers();
    try {
      const h = build({ broadcast: { status: 'QUEUED' }, perSecond: 1 });
      const done = h.svc.run('b1');
      await jest.runAllTimersAsync();
      await done;
      expect(h.b).toMatchObject({ status: 'DONE', processedCount: 3 });
      expect(h.b.startedAt).toBeInstanceOf(Date);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('pause, resume, cancel', () => {
  it('pause stops a sending broadcast; resume carries on with a new job', async () => {
    const h = build();
    await expect(h.svc.pause('b1', 'a1')).resolves.toMatchObject({ status: 'PAUSED' });
    await expect(h.svc.resume('b1', 'a1')).resolves.toMatchObject({ status: 'SENDING' });
    expect(h.queue.add).toHaveBeenCalledWith('run-broadcast', { broadcastId: 'b1' }, expect.anything());
  });

  it('cancel stops it for good', async () => {
    const h = build({ broadcast: { status: 'PAUSED' } });
    await expect(h.svc.cancel('b1', 'a1')).resolves.toMatchObject({ status: 'CANCELLED' });
    expect(h.b.finishedAt).toBeInstanceOf(Date);
  });

  it('a finished broadcast cannot be paused, resumed or cancelled', async () => {
    const h = build({ broadcast: { status: 'DONE' } });
    await expect(h.svc.pause('b1', 'a1')).rejects.toThrow(/can't be paused/);
    await expect(h.svc.resume('b1', 'a1')).rejects.toThrow(/can't be resumed/);
    await expect(h.svc.cancel('b1', 'a1')).rejects.toThrow(/can't be cancelled/);
  });
});

describe('history: what the Broadcasts page shows', () => {
  it('each broadcast with its progress, counts, opens and sender', async () => {
    const h = build();
    const row = { id: 'b1', title: 'Hello', body: 'News', audience: 'ALL', status: 'SENDING', withEmail: true, recipientCount: 200, processedCount: 50, pushSentCount: 40, pushFailedCount: 2, emailQueuedCount: 30, sentBy: 'a1', createdAt: new Date(), startedAt: new Date(), finishedAt: null };
    Object.assign(h.prisma.broadcast, { findMany: jest.fn(async () => [row]) });
    Object.assign(h.prisma, {
      notification: { ...h.prisma.notification, groupBy: jest.fn(async () => [{ broadcastId: 'b1', _count: { _all: 7 } }]) },
      adminUser: { findMany: jest.fn(async () => [{ id: 'a1', name: 'Owner' }]) },
    });
    const [r] = await h.svc.history();
    expect(r).toMatchObject({ id: 'b1', status: 'SENDING', withEmail: true, recipientCount: 200, processedCount: 50, percent: 25, pushSentCount: 40, pushFailedCount: 2, emailQueuedCount: 30, readCount: 7, sentByName: 'Owner' });
  });

  it('percent never passes 100 and is 100 when done', async () => {
    const h = build();
    Object.assign(h.prisma.broadcast, { findMany: jest.fn(async () => [{ id: 'b1', status: 'DONE', recipientCount: 10, processedCount: 12, sentBy: 'a1' }]) });
    Object.assign(h.prisma, { notification: { groupBy: jest.fn(async () => []) }, adminUser: { findMany: jest.fn(async () => []) } });
    expect((await h.svc.history())[0].percent).toBe(100);
  });
});
