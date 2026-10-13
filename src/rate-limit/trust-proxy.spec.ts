import express from 'express';
import request from 'supertest';
import { isProxyAddress, trustProxySetting } from './trust-proxy';

/** The behavior main.ts relies on, with whatever main.ts would hand to 'trust proxy'. */
function appWith(trust: number | string[]) {
  const app = express();
  app.set('trust proxy', trust);
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

  it('with hops, a client that reaches the API directly CAN fake its IP: why production should name the proxy instead', async () => {
    // Nothing distinguishes Nginx from anyone else here: one hop is trusted, whoever it is.
    const res = await request(appWith(1)).get('/ip').set('X-Forwarded-For', '6.6.6.6');
    expect(res.body.ip).toBe('6.6.6.6');
  });
});

describe("Express 'trust proxy' with the proxy's own address", () => {
  it('honours X-Forwarded-For when the connection comes from the named proxy', async () => {
    // supertest connects from loopback, standing in for Nginx on the same host.
    const res = await request(appWith(['loopback'])).get('/ip').set('X-Forwarded-For', '6.6.6.6, 203.0.113.9');
    expect(res.body.ip).toBe('203.0.113.9');
  });

  it('ignores X-Forwarded-For from anything that is not the named proxy, so a direct client cannot fake its IP', async () => {
    const res = await request(appWith(['10.0.0.5'])).get('/ip').set('X-Forwarded-For', '6.6.6.6');
    expect(res.body.ip).not.toBe('6.6.6.6');
    expect(res.body.ip).toMatch(/127\.0\.0\.1|::1/);
  });
});

describe('isProxyAddress', () => {
  it('accepts the named ranges, IPs and IP/prefix in the form Express understands', () => {
    for (const ok of ['loopback', 'linklocal', 'uniquelocal', '127.0.0.1', '10.0.0.0/8', '172.16.0.5', '::1', 'fd00::/8']) {
      expect(isProxyAddress(ok)).toBe(true);
    }
  });

  it('refuses host names, bad prefixes and junk', () => {
    for (const bad of ['', 'nginx.local', '10.0.0.0/33', '::1/129', '10.0.0.1/8/1', '999.1.1.1', '10.0.0.0/x', '*']) {
      expect(isProxyAddress(bad)).toBe(false);
    }
  });
});

describe('trustProxySetting', () => {
  it("prefers the proxy's addresses, then a hop count, then trusts nothing", () => {
    expect(trustProxySetting({ TRUST_PROXY_ADDRESSES: ['loopback'], TRUST_PROXY_HOPS: undefined })).toEqual(['loopback']);
    expect(trustProxySetting({ TRUST_PROXY_ADDRESSES: [], TRUST_PROXY_HOPS: 1 })).toBe(1);
    expect(trustProxySetting({ TRUST_PROXY_ADDRESSES: [], TRUST_PROXY_HOPS: undefined })).toBe(0);
  });
});

describe('the dashboard chain: browser → Nginx → dashboard → API, all on loopback', () => {
  it('identifies each admin by the address Nginx appended, and ignores anything the browser forged before it', async () => {
    const app = appWith(['loopback']);
    // Nginx appends the real client after whatever the browser sent; the dashboard forwards the header unchanged.
    const first = await request(app).get('/ip').set('X-Forwarded-For', '6.6.6.6, 203.0.113.5');
    const second = await request(app).get('/ip').set('X-Forwarded-For', '6.6.6.6, 203.0.113.6');
    expect(first.body.ip).toBe('203.0.113.5');
    expect(second.body.ip).toBe('203.0.113.6');
    expect([first.body.ip, second.body.ip]).not.toContain('6.6.6.6');
  });
});
