# End-to-end tests

These tests call a **running local API** over real HTTP, the way the mobile app does: real routing, guards, validation, rate limits, database and Redis. Only the outside providers (Quidax, Flutterwave, Dojah) are the built-in mocks.

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

**2. Start the API with the mocks** (terminal 1, from `api/`):

```bash
DOJAH_USE_MOCK=true KYC_BASIC_ENABLED=true QUIDAX_USE_MOCK=true FLW_USE_MOCK=true \
ALERT_DEFAULT_RECIPIENTS=ops@davochain.invalid RATE_LIMIT_AUTH_REGISTER_IP=1000/1h \
npm run start:dev
```

`RATE_LIMIT_AUTH_REGISTER_IP=1000/1h` matters: one full run registers about 50 users, and the real limit is 5 per hour per IP.

**3. Create an admin, once** (for `admin.e2e-spec.ts`):

```bash
npm run create-admin -- --email e2e-owner@davochain.invalid --password 'Pick-a-long-password-9'
```

**4. Run the tests** (terminal 2, from `api/`):

```bash
E2E_ADMIN_EMAIL=e2e-owner@davochain.invalid E2E_ADMIN_PASSWORD='Pick-a-long-password-9' npm run test:e2e
```

### Useful variations

| Command | Does |
|---|---|
| `npm run test:e2e` | everything; the admin suite is **skipped** without `E2E_ADMIN_*` |
| `npm run test:e2e -- test/e2e/kyc-basic` | one file |
| `npm run test:e2e -- -t "Idempotency"` | tests whose name matches |
| `API_URL=http://localhost:3001 npm run test:e2e` | a server on another port (default `http://localhost:3000`) |
| `npm test` | the unit tests (no server needed) |

## When something fails

| Message | Fix |
|---|---|
| `No API at http://localhost:3000` | the server isn't running, or runs on another port (set `API_URL`) |
| `Could not register a test user (429 …)` | restart the server with `RATE_LIMIT_AUTH_REGISTER_IP=1000/1h`, or wait the seconds shown |
| `Basic verification did not approve (503 …)` | start the server with `DOJAH_USE_MOCK=true KYC_BASIC_ENABLED=true ALERT_DEFAULT_RECIPIENTS=…` |
| `Admin login failed` | check `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD`, or re-run `create-admin` (it resets the password) |
| A maintenance test fails half-way | it restores the setting in a `finally` block. If the server was killed mid-test, switch it off in the dashboard (System → Site settings). |
