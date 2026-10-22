#!/usr/bin/env node
/**
 * Start the API in end-to-end TEST mode: every outside provider mocked, Basic
 * and Advanced verification switched on, and a sign-up limit high enough for the e2e suite
 * (one run registers ~50 users; the real limit is 5 per hour per IP).
 *
 *   npm run start:e2e              (port 3000, the default the tests use)
 *   npm run start:e2e -- 3001      (another port; then run the tests with API_URL)
 *   npm run start:e2e -- 3001 --real-limits
 *                                  (the same, but every rate limit at its real default:
 *                                   only for test/e2e/rate-limits.e2e-spec.ts)
 *   npm run start:e2e -- 3001 --payrep-sandbox
 *                                  (the same, but naira goes to Payrep's real SANDBOX, using the
 *                                   PAYREP_* keys in api/.env; everything else stays mocked)
 *
 * Works the same in PowerShell, cmd and Bash, because the settings are set here
 * rather than with shell syntax. Refuses to run with NODE_ENV=production.
 */
import { spawn, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const payrepSandbox = args.includes('--payrep-sandbox');
const port = args.find((a) => /^\d+$/.test(a)) ?? process.env.PORT ?? '3000';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing: start:e2e mocks every provider and must never run in production.');
  process.exit(1);
}

const testSettings = {
  PORT: port,
  DOJAH_USE_MOCK: 'true',
  KYC_BASIC_ENABLED: 'true',
  // Advanced checks (spec 2026-10-21) on the Dojah mock.
  KYC_ADVANCED_ENABLED: 'true',
  QUIDAX_USE_MOCK: 'true',
  // The pretend Payrep, unless --payrep-sandbox: then the real sandbox (never the live system:
  // env validation refuses live keys outside production).
  PAYREP_USE_MOCK: payrepSandbox ? 'false' : 'true',
  // Naira deposit accounts on.
  NGN_DEPOSITS_ENABLED: 'true',
  // Files go to the in-memory store, never the real R2 bucket.
  STORAGE_DRIVER: 'memory',
  ALERT_DEFAULT_RECIPIENTS: process.env.ALERT_DEFAULT_RECIPIENTS ?? 'ops@davochain.invalid',
  RATE_LIMIT_AUTH_REGISTER_IP: '1000/1h',
  // Several full runs in a row sign in far more than 20 times per 15 minutes from one address.
  RATE_LIMIT_AUTH_LOGIN_IP: '2000/15m',
  // Every admin suite signs the same test owner in; a full run passes 10 per 15 minutes on its own.
  RATE_LIMIT_AUTH_LOGIN_ACCT: '2000/15m',
  // The two-step suite changes its own settings more than 5 times in an hour.
  RATE_LIMIT_AUTH_CHANGE_PASSWORD_USER: '2000/1h',
};

// --real-limits: every rate limit at its real default (for test/e2e/rate-limits.e2e-spec.ts).
if (args.includes('--real-limits')) {
  for (const k of Object.keys(testSettings)) if (k.startsWith('RATE_LIMIT_')) delete testSettings[k];
}

console.log(`\n  Starting the API in e2e test mode on port ${port}:`);
for (const [k, v] of Object.entries(testSettings)) console.log(`    ${k}=${v}`);
console.log('');

// Same courtesy as start:dev: free the port if a stale run still holds it.
try {
  execFileSync(process.execPath, [join(root, 'scripts', 'free-port.mjs'), port], { stdio: 'inherit' });
} catch {
  process.exit(1);
}

const child = spawn('npx', ['nest', 'start', '--watch'], {
  cwd: root,
  env: { ...process.env, ...testSettings },
  stdio: 'inherit',
  shell: true,
});
child.on('exit', (code) => process.exit(code ?? 0));
