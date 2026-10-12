import express from 'express';
import request from 'supertest';

/** The behavior main.ts relies on: with one trusted hop, only the entry Nginx appended counts. */
function appWith(hops: number) {
  const app = express();
  app.set('trust proxy', hops);
  app.get('/ip', (req, res) => res.json({ ip: req.ip }));
  return app;
}

describe("Express 'trust proxy' with a hop count", () => {
  it('with one hop, takes the right-most X-Forwarded-For entry and ignores what the client forged before it', async () => {
    const res = await request(appWith(1)).get('/ip').set('X-Forwarded-For', '6.6.6.6, 203.0.113.9');
    expect(res.body.ip).toBe('203.0.113.9');
  });

  it('with no hops, ignores X-Forwarded-For entirely', async () => {
    const res = await request(appWith(0)).get('/ip').set('X-Forwarded-For', '6.6.6.6');
    expect(res.body.ip).not.toBe('6.6.6.6');
  });
});
