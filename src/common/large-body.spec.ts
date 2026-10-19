import express from 'express';
import request from 'supertest';
import { registerLargeBodyRoutes, LARGE_BODY_BYTES } from './large-body';

/** The order main.ts uses: the large-body route first, then the global 1 MB parser. */
function app(verify: (token: string) => Promise<boolean>) {
  const a = express();
  const reached = jest.fn();
  registerLargeBodyRoutes(a, { prefix: 'v1', verify });
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

  it('does not apply to reading trades (GET), only to the sale (POST)', async () => {
    const verify = jest.fn(ok);
    const { a } = app(verify);
    a.get('/v1/giftcards/trades', (_req, res) => res.json([]));
    const res = await request(a).get('/v1/giftcards/trades');
    expect(res.status).toBe(200);
    expect(verify).not.toHaveBeenCalled();
  });
});
