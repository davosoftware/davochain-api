import express from 'express';
import request from 'supertest';
import { registerLargeBodyRoutes, LARGE_BODY_BYTES } from './large-body';

/** The order main.ts uses: the large-body route first, then the global 1 MB parser. */
function app(verify: (token: string) => Promise<boolean>, verifyAdmin: (token: string) => Promise<boolean> = async (t) => t === 'admin-token') {
  const a = express();
  const reached = jest.fn();
  registerLargeBodyRoutes(a, { prefix: 'v1', verify, verifyAdmin });
  a.use(express.json({ limit: '1mb' }));
  a.post('/v1/giftcards/trades', (req, res) => {
    reached(JSON.stringify(req.body).length);
    res.status(201).json({ ok: true });
  });
  a.post('/v1/other', (req, res) => res.status(201).json({ ok: true }));
  return { a, reached };
}

const ok = async (t: string) => t === 'good-token';
const body = (bytes: number) => JSON.stringify({ typeId: 't', faceValue: '50', images: ['x'.repeat(bytes)] });

describe('The large-body route (gift-card sale, up to 36 MB)', () => {
  it('lets a signed-in 2 MB sale through, which the normal 1 MB limit used to refuse', async () => {
    const { a, reached } = app(ok);
    const res = await request(a).post('/v1/giftcards/trades').set('authorization', 'Bearer good-token').set('content-type', 'application/json').send(body(2 * 1024 * 1024));
    expect(res.status).toBe(201);
    expect(reached).toHaveBeenCalled();
  });

  it('lets a 30 MB sale through (five 5 MB photos in base64 is about 33 MB)', async () => {
    const { a } = app(ok);
    const res = await request(a).post('/v1/giftcards/trades').set('authorization', 'Bearer good-token').set('content-type', 'application/json').send(body(30 * 1024 * 1024));
    expect(res.status).toBe(201);
  });

  it('refuses a request without a valid sign-in BEFORE reading its body', async () => {
    const verify = jest.fn(ok);
    const { a, reached } = app(verify);
    const none = await request(a).post('/v1/giftcards/trades').set('content-type', 'application/json').send(body(2 * 1024 * 1024));
    expect(none.status).toBe(401);
    const bad = await request(a).post('/v1/giftcards/trades').set('authorization', 'Bearer forged').set('content-type', 'application/json').send(body(10));
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ statusCode: 401, message: 'Invalid or expired token' });
    expect(reached).not.toHaveBeenCalled();
  });

  it('refuses a body over the 36 MB limit with 413 in plain words', async () => {
    const { a, reached } = app(ok);
    const res = await request(a).post('/v1/giftcards/trades').set('authorization', 'Bearer good-token').set('content-type', 'application/json').send(body(LARGE_BODY_BYTES + 1024));
    expect(res.status).toBe(413);
    expect(res.body.message).toMatch(/too large/i);
    expect(reached).not.toHaveBeenCalled();
  });

  it('leaves every other route at the normal 1 MB limit', async () => {
    const { a } = app(ok);
    const res = await request(a).post('/v1/other').set('authorization', 'Bearer good-token').set('content-type', 'application/json').send(body(2 * 1024 * 1024));
    expect(res.status).toBe(413);
  });

  describe('admin pictures (C7): logos, brand images, profile pictures, email images, up to 8 MB', () => {
    const picture = (bytes: number) => JSON.stringify({ dataUrl: `data:image/png;base64,${'A'.repeat(bytes)}` });
    const routes = ['/v1/admin/me/avatar', '/v1/admin/site-settings/logo', '/v1/admin/giftcards/brands', '/v1/admin/cms/email-templates/user.welcome/image'];
    const withRoutes = () => {
      const made = app(ok);
      for (const r of routes) made.a.put(r, (_req, res) => res.status(200).json({ ok: true }));
      made.a.put('/v1/admin/other', (_req, res) => res.status(200).json({ ok: true }));
      return made.a;
    };

    it.each(routes)('%s takes a 3 MB picture with an admin sign-in', async (route) => {
      const res = await request(withRoutes()).put(route).set('authorization', 'Bearer admin-token').set('content-type', 'application/json').send(picture(3 * 1024 * 1024));
      expect(res.status).toBe(200);
    });

    it('a customer sign-in, or none, is refused', async () => {
      for (const auth of ['Bearer good-token', '']) {
        const r = request(withRoutes()).put('/v1/admin/me/avatar').set('content-type', 'application/json');
        // A small body: the server answers before reading it and closes, which can reset a client still sending megabytes.
        const res = await (auth ? r.set('authorization', auth) : r).send(picture(10));
        expect(res.status).toBe(401);
      }
    });

    it('over 8 MB is refused with 413 in plain words', async () => {
      const res = await request(withRoutes()).put('/v1/admin/site-settings/logo').set('authorization', 'Bearer admin-token').set('content-type', 'application/json').send(picture(9 * 1024 * 1024));
      expect(res.status).toBe(413);
      expect(res.body.message).toMatch(/picture is too large/i);
    });

    it('other admin routes keep the normal 1 MB limit', async () => {
      const res = await request(withRoutes()).put('/v1/admin/other').set('authorization', 'Bearer admin-token').set('content-type', 'application/json').send(picture(2 * 1024 * 1024));
      expect(res.status).toBe(413);
    });
  });

  it('does not apply to reading trades (GET), only to the sale (POST)', async () => {
    const verify = jest.fn(ok);
    const { a } = app(verify);
    a.get('/v1/giftcards/trades', (_req, res) => res.json([]));
    const res = await request(a).get('/v1/giftcards/trades');
    expect(res.status).toBe(200);
    expect(verify).not.toHaveBeenCalled();
  });
});
