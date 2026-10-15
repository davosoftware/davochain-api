/**
 * Shared helpers for the end-to-end suite: real HTTP calls to a RUNNING local
 * API (see test/e2e/README.md). Nothing here touches production: it refuses any
 * API_URL that is not this machine.
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const BASE = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
export const API = `${BASE}/v1`;

const host = new URL(BASE).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  throw new Error(`Refusing to run end-to-end tests against ${host}: they create users and trades. Use a local server.`);
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function call<T = any>(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {},
): Promise<Res<T>> {
  const url = path.startsWith('http') ? path : path.startsWith('/health') || path.startsWith('/webhooks') ? BASE + path : API + path;
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: keep the text
  }
  return { status: res.status, body: body as T, headers: res.headers };
}

/** Fails fast with a useful message when no server is running. */
export async function requireServer(): Promise<void> {
  try {
    const r = await call('GET', '/health');
    if (r.status !== 200) throw new Error(`health answered ${r.status}`);
  } catch (err) {
    throw new Error(`No API at ${BASE} (${(err as Error).message}). Start it first with \`npm run start:e2e\` and wait for "listening" (test/e2e/README.md).`);
  }
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  phone: string;
  token: string;
  refreshToken: string;
}

let counter = 0;
export function uniquePhone(): string {
  counter++;
  return '+23480' + String(Date.now()).slice(-6) + String(counter).padStart(2, '0');
}

/** A fresh, unverified user, logged in. */
export async function newUser(firstName = 'E2e', lastName = 'Tester'): Promise<TestUser> {
  const email = `e2e-${randomUUID().slice(0, 12)}@davochain.invalid`;
  const password = `E2e-${randomUUID().slice(0, 10)}-9`;
  const phone = uniquePhone();
  const r = await call('POST', '/auth/register', { body: { email, password, firstName, lastName, phone } });
  if (r.status !== 201) {
    throw new Error(
      `Could not register a test user (${r.status} ${JSON.stringify(r.body)}). ` +
        'If this is 429, the server is not in test mode: stop it and start it with `npm run start:e2e` (test/e2e/README.md).',
    );
  }
  return { id: r.body.userId, email, password, phone, token: r.body.accessToken, refreshToken: r.body.refreshToken };
}

export async function login(user: TestUser): Promise<TestUser> {
  const r = await call('POST', '/auth/login', { body: { email: user.email, password: user.password } });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...user, token: r.body.accessToken, refreshToken: r.body.refreshToken };
}

export const ADDRESS = { street: '1 E2E Street', city: 'Ikeja', state: 'Lagos', lga: 'Ikeja' };

/**
 * A fresh 11-digit BVN/NIN from a Dojah-mock family: '333' is the clean person,
 * '222' the PEP sandbox person, '666' sanctioned, '777' a possible match.
 * One number verifies one account (H8), so every test user needs its own.
 */
export function idNumber(family: '333' | '222' | '666' | '777'): string {
  return family + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
}

/** Basic verification with the Dojah mock's clean identity, then a fresh login (approval ends sessions). */
export async function verifyBasic(user: TestUser): Promise<TestUser> {
  const r = await call('POST', '/kyc/basic', {
    token: user.token,
    body: { idType: 'BVN', idNumber: idNumber('333'), firstName: 'Someone', lastName: 'Clean', dateOfBirth: '1995-03-03', address: ADDRESS, stateOfOrigin: 'Lagos', country: 'NG' },
  });
  if (r.status !== 201 || r.body.state !== 'APPROVED') {
    throw new Error(
      `Basic verification did not approve (${r.status} ${JSON.stringify(r.body)}). ` +
        'The server is not in test mode: stop it and start it with `npm run start:e2e` (test/e2e/README.md).',
    );
  }
  return login(user);
}

/** Test money, through the development-only ledger script (refuses in production). */
export function credit(user: TestUser, asset: string, amount: string): void {
  execSync(`node scripts/dev-credit.mjs --email ${user.email} --asset ${asset} --amount ${amount}`, {
    cwd: join(__dirname, '..', '..'),
    stdio: 'ignore',
  });
}

export async function balance(user: TestUser, asset: string): Promise<{ available: string; locked: string; total: string }> {
  const r = await call('GET', '/wallets', { token: user.token });
  const w = (r.body as Array<{ asset: string; available: string; locked: string; total: string }>).find((x) => x.asset === asset);
  if (!w) throw new Error(`no ${asset} wallet`);
  return w;
}

/** An admin token, or null when E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD are not set (admin suites then skip). */
export async function adminToken(): Promise<string | null> {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) return null;
  const r = await call('POST', '/admin/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`Admin login failed (${r.status}). Check E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD.`);
  return r.body.accessToken;
}

export const hasAdmin = Boolean(process.env.E2E_ADMIN_EMAIL && process.env.E2E_ADMIN_PASSWORD);

export const key = (): string => randomUUID();

/** Money is always a string of digits with an optional decimal part. */
export const MONEY = /^\d+(\.\d+)?$/;
