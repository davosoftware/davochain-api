# End-to-end tests

These tests call a **running local API** over real HTTP, the way the mobile app does: real routing, guards, validation, rate limits, database and Redis. Only the outside providers (Quidax, Payrep, Dojah) are the built-in mocks.

They complement the **unit tests** (`npm test`, 1,084 tests in `src/**/*.spec.ts`), which need no server.

## What they cover

| File | Covers |
|---|---|
| `health-and-public.e2e-spec.ts` | health, public routes, the states/LGA list, missing/garbage tokens, removed and unknown routes |
| `auth.e2e-spec.ts` | register (success, taken email, taken phone, required phone, password rules, unknown fields), login, account-fishing protection, refresh rotation, logout, password reset |
| `kyc-basic.e2e-spec.ts` | KYC status, the verification gate, approval, re-login, raw BVN never returned, already verified, not found, name mismatch → review, provider failure → 503 with no attempt used, PEP → compliance review, sanctions → blocked, every validation error |
| `trading.e2e-spec.ts` | quotes, the trade cap, balance checks, bad amounts, Idempotency-Key required and honoured, single-use quotes, other users can't use or see your trades, history, balances moving by exactly the quoted amounts, no phantom deposit after a buy |
| `withdrawals-and-deposits.e2e-spec.ts` | crypto and naira fee quotes (good and bad amounts), withdrawals need verification, deposit addresses, histories, the naira-account 404 |
| `admin.e2e-spec.ts` | admin login, user tokens refused, permissions, every main admin list, the identity-review decision, the old review route refusing Basic, a full compliance case (open → view → wrong decision refused → EDD approval → user becomes Basic → decided case can't be changed), maintenance mode on and off |

They are **safe**: they refuse to run against anything but `localhost`. They create throwaway users named `e2e-…@davochain.invalid` in your **local** database.

## How to run

**1. Start Postgres and Redis**, at the workspace root:

```bash
docker compose up -d
```

**2. Start the API in test mode** (terminal 1, from `api/`). **Stop `npm run start:dev` first**: this replaces it.

```
npm run start:e2e
```

It works the same in PowerShell, cmd and Bash, and prints the settings it uses:
- every provider mocked: `DOJAH_USE_MOCK`, `QUIDAX_USE_MOCK`, `PAYREP_USE_MOCK` (with naira deposits on: `NGN_DEPOSITS_ENABLED`);
- Basic verification on: `KYC_BASIC_ENABLED`, `ALERT_DEFAULT_RECIPIENTS`;
- `RATE_LIMIT_AUTH_REGISTER_IP=1000/1h`, because one full run registers about 50 users and the real limit is 5 per hour per IP.

Wait for `Davochain API listening on :3000`. To use another port: `npm run start:e2e -- 3001`, then set `API_URL` (step 4).

**3. Create an admin, once** (for `admin.e2e-spec.ts`):

```bash
npm run create-admin -- --email e2e-owner@davochain.invalid --password 'Pick-a-long-password-9'
```

**4. Run the tests** (terminal 2, from `api/`).

PowerShell:

```powershell
$env:E2E_ADMIN_EMAIL = "e2e-owner@davochain.invalid"
$env:E2E_ADMIN_PASSWORD = "Pick-a-long-password-9"
npm run test:e2e
```

Git Bash:

```bash
E2E_ADMIN_EMAIL=e2e-owner@davochain.invalid E2E_ADMIN_PASSWORD='Pick-a-long-password-9' npm run test:e2e
```

Expected result: `Test Suites: 6 passed` and `Tests: 89 passed`. In PowerShell a red `NativeCommandError` line may also appear. That is only PowerShell labelling Jest's normal output (Jest writes it to stderr); the `Tests:` line is what counts.

### Useful variations

| Command | Does |
|---|---|
| `npm run test:e2e` | everything; the admin suite is **skipped** without `E2E_ADMIN_*` |
| `npm run test:e2e -- test/e2e/kyc-basic` | one file |
| `npm run test:e2e -- -t "Idempotency"` | tests whose name matches |
| `$env:API_URL = "http://localhost:3001"` (PowerShell) or `API_URL=http://localhost:3001` (Bash), then `npm run test:e2e` | a server on another port (default `http://localhost:3000`) |
| `npm test` | the unit tests (no server needed) |

## When something fails

| Message | Fix |
|---|---|
| `No API at http://localhost:3000` | the server isn't running yet (wait for "listening"), or runs on another port (set `API_URL`) |
| `Could not register a test user (429 …)` | the server was started with `npm run start:dev`, not `npm run start:e2e`, so the real sign-up limit (5 per hour) applies. Stop it and run `npm run start:e2e`. |
| `Basic verification did not approve (503 …)` | the same: start the server with `npm run start:e2e` |
| `-t "…"` still fails in setup | `-t` picks which tests run, but each file's setup (registering a user) still runs, so it needs the test-mode server too |
| `Admin login failed` | check `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD`, or re-run `create-admin` (it resets the password) |
| A maintenance test fails half-way | it restores the setting in a `finally` block. If the server was killed mid-test, switch it off in the dashboard (System → Site settings). |

## When your own dev server is running (Advanced checks, 21 Oct 2026)

Advanced KYC checks run on a background queue in Redis. If your dev server (`npm run start:dev`, port 3000) is running from the same folder, it shares that queue and can pick up the test server's jobs, but it can't see the test server's in-memory files, so checks sit in "CHECKING" for a while. Give the test server its own Redis:

```bash
docker run -d --name davochain-e2e-redis -p 6380:6379 redis:7-alpine
REDIS_PORT=6380 npm run start:e2e -- 3001
API_URL=http://localhost:3001 E2E_ADMIN_EMAIL=… E2E_ADMIN_PASSWORD=… npm run test:e2e
docker rm -f davochain-e2e-redis
```

## Launch tests (22 Oct 2026)

Three files were added for launch:

| File | What it proves | Needs |
|---|---|---|
| `journey.e2e-spec.ts` | One customer, start to finish: sign up, confirm email, Basic verification, naira deposit account, ₦200,000 arrives, buy crypto, sell a gift card, withdraw naira, swap, sign out | `E2E_ADMIN_*` |
| `races.e2e-spec.ts` | Requests fired at the same moment: identical sign-ins share one session, a wrong password raced 5 times counts once, refresh tokens are single use, one quote trades once, the same Idempotency-Key runs once, the balance never goes below zero, one deposit account per customer | nothing extra |
| `rate-limits.e2e-spec.ts` | Every rate limit at its real default, one request over the limit each | its own run, below |

Both `journey` and `races` run with the normal suite.

### Rate limits: a separate run

The normal test server raises some limits (so a full run doesn't trip them), so the limits get their own server with the real numbers. This uses up the limits for your computer's address for up to an hour, so run it last.

```bash
# 1. Clear old counters in the TEST Redis (port 6380), never your dev Redis
docker exec davochain-e2e-redis sh -c "redis-cli --scan --pattern 'rl:*' | xargs -r redis-cli del"

# 2. Start the test server with the real limits
REDIS_PORT=6380 npm run start:e2e -- 3001 --real-limits

# 3. In another terminal, run only the rate-limit file
RATE_LIMIT_E2E=yes API_URL=http://localhost:3001 E2E_ADMIN_EMAIL=… E2E_ADMIN_PASSWORD=… npx jest --config test/jest-e2e.json test/e2e/rate-limits.e2e-spec.ts

# 4. Afterwards: clear the counters again and restart the server without --real-limits
```

`--set-code` on `scripts/dev-verify-email.mjs` puts a known code on a customer's newest emailed code, so a test can type it into `POST /v1/auth/email/verify` like a customer.
