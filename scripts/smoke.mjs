#!/usr/bin/env node
/**
 * End-to-end smoke test against a locally running server.
 *
 *   npm run smoke
 *
 * Node's built-in fetch, no dependencies, no shell quoting to get wrong.
 * Safe to run repeatedly — it registers a fresh throwaway user each time.
 *
 * Runs against the MOCK Quidax client, so nothing here touches real money.
 */

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';
const API = `${BASE}/v1`;

let passed = 0;
let failed = 0;
const notes = [];

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const d = (s) => `\x1b[90m${s}\x1b[0m`;

async function step(name, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`${g('  PASS')}  ${name}${detail ? d('  ' + detail) : ''}`);
    return true;
  } catch (err) {
    failed++;
    console.log(`${r('  FAIL')}  ${name}`);
    console.log(d(`        ${err.message}`));
    return false;
  }
}

async function call(method, path, { token, body, expect = [200, 201] } = {}) {
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      // Every mutating route requires this; a fresh key per call is correct here.
      ...(method !== 'GET' ? { 'idempotency-key': crypto.randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }

  if (!expect.includes(res.status)) {
    throw new Error(
      `${method} ${path} -> ${res.status} ${typeof json === 'object' ? JSON.stringify(json?.message ?? json) : json}`,
    );
  }
  return json;
}

console.log(`\nDavochain smoke test  ${d(BASE)}\n`);

// ── 1. is it up ───────────────────────────────────────────────
const health = await step('server is up and the database is reachable', async () => {
  const h = await call('GET', `${BASE}/health`);
  if (h.database !== 'up') throw new Error(`database is "${h.database}" — is Postgres running?`);
  notes.push(`Quidax mode: ${h.quidax}`);
  return `quidax=${h.quidax} env=${h.env}`;
});

if (!health) {
  console.log(
    `\n${r('Cannot continue.')} Start the server with ${g('npm run start:dev')} and make sure Postgres is running.\n`,
  );
  process.exit(1);
}

// ── 2. catalogue ──────────────────────────────────────────────
let assets = [];
await step('assets are listed with their chains', async () => {
  assets = await call('GET', '/assets');
  if (assets.length === 0) throw new Error('no assets — did you run `npm run seed`?');

  const withoutChains = assets.filter((a) => a.networks.length === 0).map((a) => a.code);
  if (withoutChains.length > 0) {
    throw new Error(`no chains for: ${withoutChains.join(', ')} — deposits would be impossible`);
  }
  return `${assets.length} coins`;
});

await step('stablecoins carry their full chain surface', async () => {
  const usdt = assets.find((a) => a.code === 'usdt');
  const usdc = assets.find((a) => a.code === 'usdc');
  if (!usdt || !usdc) throw new Error('usdt/usdc missing from the catalogue');
  if (usdt.networks.length < 10) throw new Error(`usdt has ${usdt.networks.length} chains, expected 10`);
  if (usdc.networks.length < 7) throw new Error(`usdc has ${usdc.networks.length} chains, expected 7`);

  // The one only the API knows about.
  const arb = usdt.networks.find((n) => n.id === 'arbitrum');
  if (arb && arb.withdrawsEnabled) notes.push('note: arbitrum shows withdraws enabled');
  return `usdt=${usdt.networks.length} usdc=${usdc.networks.length}`;
});

await step('XRP is flagged as needing a destination tag', async () => {
  const xrp = assets.find((a) => a.code === 'xrp');
  const chain = xrp?.networks[0];
  if (!chain?.requiresTag) throw new Error('XRP is not flagged — a deposit without a tag would be lost');
  return `network=${chain.id}`;
});

// ── 3. auth ───────────────────────────────────────────────────
const email = `smoke_${Date.now()}@test.davochain.com`;
const password = 'SmokeTest12345';
let token;
let refreshToken;
let userId;

await step('a user can register', async () => {
  const out = await call('POST', '/auth/register', {
    body: { email, password, firstName: 'Smoke', lastName: 'Test' },
  });
  token = out.accessToken;
  refreshToken = out.tokens.refreshToken;
  userId = out.userId;
  return email;
});

await step('a user can log in', async () => {
  const out = await call('POST', '/auth/login', { body: { email, password } });
  if (!out.accessToken) throw new Error('no access token returned');
  return `expires in ${out.expiresIn}`;
});

await step('the wrong password is rejected', async () => {
  await call('POST', '/auth/login', { body: { email, password: 'wrong-password' }, expect: [401] });
  return '401 as expected';
});

await step('refresh returns a new pair and retires the old one', async () => {
  const first = await call('POST', '/auth/refresh', { body: { refreshToken } });
  if (!first.refreshToken) throw new Error('no new refresh token');
  // Re-using the retired token must fail — that is the leak detector.
  await call('POST', '/auth/refresh', { body: { refreshToken }, expect: [401] });
  refreshToken = first.refreshToken;
  token = first.accessToken;
  return 'reuse of the old token rejected';
});

await step('an unauthenticated call is refused', async () => {
  await call('GET', '/wallets', { expect: [401] });
  return '401 as expected';
});

// ── 4. the user's own data ────────────────────────────────────
await step('profile reads back', async () => {
  const me = await call('GET', '/me', { token });
  if (me.email !== email) throw new Error('wrong user returned');
  notes.push(`wallet provisioning: ${me.walletReady ? 'ready' : 'still queued (needs Redis)'}`);
  return `kyc=${me.kyc.tier}/${me.kyc.status}`;
});

await step('balances come back for every listed coin', async () => {
  const wallets = await call('GET', '/wallets', { token });
  if (wallets.length === 0) throw new Error('no balances returned');
  const ngn = wallets.find((w) => w.asset === 'ngn');
  if (!ngn) throw new Error('naira wallet missing');
  return `${wallets.length} wallets, ngn=${ngn.available}`;
});

// ── 5. KYC gating ─────────────────────────────────────────────
await step('trading is blocked at TIER_0', async () => {
  const res = await fetch(`${API}/quotes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ side: 'buy', fromAsset: 'ngn', toAsset: 'btc', amount: '50000' }),
  });
  if (res.status !== 403) throw new Error(`expected 403, got ${res.status}`);
  const body = await res.json();
  if (!body.requiredTier) throw new Error('403 did not say which tier is required');
  return `needs ${body.requiredTier}, has ${body.currentTier}`;
});

await step('KYC status is readable', async () => {
  const kyc = await call('GET', '/kyc', { token });
  // limits is an object — { current, tiers } — not the array it used to be.
  // Reading .length off it returned undefined, which made this check pass
  // whether or not the tiers were seeded at all.
  const tiers = kyc.limits?.tiers;
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new Error('no tier limits — run `npm run seed`');
  }
  const today = kyc.limits.current?.deposit;
  if (!today?.singleNgn) throw new Error('no naira deposit cap for this tier');
  return `${tiers.length} tiers, deposit cap ₦${today.singleNgn} / ₦${today.dailyNgn} daily`;
});

await step('a KYC submission is accepted', async () => {
  const out = await call('POST', '/kyc/tier1', {
    token,
    body: { bvn: '12345678901', dateOfBirth: '1995-06-15' },
  });
  if (out.status !== 'PENDING') throw new Error(`expected PENDING, got ${out.status}`);
  return 'awaiting review';
});

// ── summary ───────────────────────────────────────────────────
console.log('');
for (const n of notes) console.log(d(`  · ${n}`));
console.log('');

if (failed === 0) {
  console.log(`${g(`  ${passed} passed`)} — the backend is working.\n`);
  console.log(d('  Next: approve KYC via the admin API to unlock trading, then quote a buy.\n'));
} else {
  console.log(`  ${g(`${passed} passed`)}, ${r(`${failed} failed`)}\n`);
  process.exitCode = 1;
}
