/**
 * Development only: the one door a public tunnel may open onto this machine.
 *
 * Payrep's sandbox must reach POST /webhooks/payrep, but a tunnel to the API
 * itself would also expose sign-in, admin and every other route. This gate
 * forwards exactly that one request (body and headers unchanged, so the
 * signature still checks) and answers 404 to anything else. It never logs a
 * body or a header.
 *
 * Run:  node scripts/webhook-gate.mjs            (listens on 8787, forwards to the API on 3001)
 *       GATE_PORT=8787 API_PORT=3000 node scripts/webhook-gate.mjs
 * Then: cloudflared tunnel --url http://localhost:8787
 */
import http from 'node:http';

const GATE_PORT = Number(process.env.GATE_PORT ?? 8787);
const API_PORT = Number(process.env.API_PORT ?? 3001);
const MAX_BYTES = 64 * 1024;
const ALLOWED = '/webhooks/payrep';
const FORWARD = ['content-type', 'x-signature', 'x-timestamp', 'x-webhook-id', 'user-agent'];

const server = http.createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  const done = (status) => console.log(`${new Date().toISOString()} ${req.method} ${path} → ${status}`);
  if (req.method !== 'POST' || path !== ALLOWED) {
    res.writeHead(404).end();
    req.resume();
    return done(404);
  }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BYTES) {
      res.writeHead(413).end();
      req.destroy();
      done(413);
    } else chunks.push(c);
  });
  req.on('end', () => {
    if (size > MAX_BYTES) return;
    const body = Buffer.concat(chunks);
    const headers = { 'content-length': String(body.length) };
    for (const h of FORWARD) if (req.headers[h] !== undefined) headers[h] = req.headers[h];
    const up = http.request({ host: '127.0.0.1', port: API_PORT, method: 'POST', path: ALLOWED, headers, timeout: 15_000 }, (r) => {
      res.writeHead(r.statusCode ?? 502, { 'content-type': r.headers['content-type'] ?? 'application/json' });
      r.pipe(res);
      done(r.statusCode);
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502).end();
      console.log(`${new Date().toISOString()} POST ${ALLOWED} → 502 (API on :${API_PORT} not reachable: ${e.message})`);
    });
    up.end(body);
  });
});

server.listen(GATE_PORT, '127.0.0.1', () => console.log(`webhook gate on :${GATE_PORT} → API :${API_PORT}, only POST ${ALLOWED}`));
