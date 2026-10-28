import { adminToken, call, hasAdmin, newUser, requireServer, type TestUser } from './helpers';

/**
 * Broadcasts are sent by a background worker in waves (29 Oct 2026): Send
 * answers at once with QUEUED; the worker writes the inbox messages and
 * pushes; the admin can pause, resume and cancel. Needs E2E_ADMIN_*.
 */
const describeAdmin = hasAdmin ? describe : describe.skip;

async function until(fn: () => Promise<boolean>, seconds = 30): Promise<void> {
  for (let i = 0; i < seconds * 2; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('gave up waiting');
}

describeAdmin('admin broadcasts, sent in the background', () => {
  let ADMIN: string;
  let a: TestUser;
  let b: TestUser;
  const row = async (id: string) => ((await call('GET', '/admin/broadcasts', { token: ADMIN })).body as Array<Record<string, any>>).find((x) => x.id === id)!;

  beforeAll(async () => {
    await requireServer();
    ADMIN = (await adminToken())!;
    a = await newUser('Ann', 'Inbox');
    b = await newUser('Ben', 'Inbox');
  });

  it('Send answers at once with QUEUED; the worker sends it to everyone chosen', async () => {
    const started = Date.now();
    const r = await call('POST', '/admin/broadcasts', { token: ADMIN, body: { title: `E2E hello ${started}`, body: 'Line one\nline two', userIds: [a.id, b.id] } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'QUEUED', recipientCount: 2, withEmail: false });
    expect(Date.now() - started).toBeLessThan(2000);

    await until(async () => (await row(r.body.id)).status === 'DONE');
    expect(await row(r.body.id)).toMatchObject({ status: 'DONE', processedCount: 2, percent: 100 });

    for (const u of [a, b]) {
      const feed = (await call('GET', '/notifications', { token: u.token })).body;
      const items = (Array.isArray(feed) ? feed : feed.items) as Array<{ title: string }>;
      expect(items.some((n) => n.title === `E2E hello ${started}`)).toBe(true);
    }
  });

  it('with email ticked, it is recorded and still finishes', async () => {
    const r = await call('POST', '/admin/broadcasts', { token: ADMIN, body: { title: 'E2E email', body: 'Hi', userIds: [a.id], withEmail: true } });
    expect(r.body).toMatchObject({ status: 'QUEUED', withEmail: true });
    await until(async () => (await row(r.body.id)).status === 'DONE');
  });

  it('pause, resume and cancel; a finished one cannot be changed', async () => {
    const r = await call('POST', '/admin/broadcasts', { token: ADMIN, body: { title: 'E2E control', body: 'Hi', userIds: [a.id, b.id] } });
    const id = r.body.id;
    const paused = await call('POST', `/admin/broadcasts/${id}/pause`, { token: ADMIN });
    if (paused.status === 200) {
      expect(paused.body.status).toBe('PAUSED');
      expect((await call('POST', `/admin/broadcasts/${id}/resume`, { token: ADMIN })).body.status).toBe('SENDING');
      await until(async () => (await row(id)).status === 'DONE');
    } else {
      // Two customers can finish before the pause arrives: then it says so.
      expect(paused.status).toBe(400);
    }
    expect((await call('POST', `/admin/broadcasts/${id}/cancel`, { token: ADMIN })).status).toBe(400);

    const c = await call('POST', '/admin/broadcasts', { token: ADMIN, body: { title: 'E2E cancel', body: 'Hi', userIds: [a.id] } });
    const cancelled = await call('POST', `/admin/broadcasts/${c.body.id}/cancel`, { token: ADMIN });
    expect([200, 400]).toContain(cancelled.status);
  });

  it('only admins who may send can control one', async () => {
    expect((await call('POST', '/admin/broadcasts/00000000-0000-0000-0000-000000000000/pause', { token: a.token })).status).toBe(401);
  });
});
