# DavoChain API

The backend for DavoChain, a Nigerian crypto exchange: buy, sell, swap, deposit and withdraw crypto and naira, sell gift cards, and verify customers' identities.

**Stack:** NestJS, Prisma + PostgreSQL, Redis (BullMQ queues, rate limits), TypeScript.
**Repository:** `davosoftware/davochain-api`; the admin dashboard is `davosoftware/Davochain-admin`.

**Last updated:** 27 October 2026.

---

## What it talks to

| Provider | What for | Without live keys |
|---|---|---|
| **Quidax** | All crypto: customer sub-accounts, deposit addresses, prices, buy/sell/swap, withdrawals | Built-in pretend Quidax (`QUIDAX_USE_MOCK=true`). **Quidax has no sandbox**: its only key is real money. |
| **Payrep MFB** | All naira: each customer's account number, deposits, withdrawals, Treasury moves to Quidax | Pretend Payrep (`PAYREP_USE_MOCK=true`), or Payrep's sandbox |
| **Dojah** | Identity: BVN/NIN (Basic), ID document, selfie and proof of address (Advanced), AML screening | Pretend Dojah (`DOJAH_USE_MOCK=true`) |
| **Cloudflare R2** | Private file storage: ID documents, selfies, gift-card photos | In-memory store (`STORAGE_DRIVER=memory`) |
| **SMTP** | Every email: sign-up code, receipts, alerts | Emails are logged instead |
| **Firebase (FCM)** | Push notifications | Push is skipped |

**The server refuses to start in production** if any pretend provider is still on, a live key is missing, or a sandbox address is used. The first error line names the setting.

---

## Quick start (development)

```bash
npm install
docker compose up -d                  # Postgres + Redis (the workspace's docker-compose.yml)
cp .env.example .env                  # the defaults use every pretend provider
#   fill JWT_SECRET, JWT_REFRESH_SECRET, ADMIN_JWT_SECRET (32+ characters each, all different):
#   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
npx prisma migrate deploy
npx prisma generate
npm run seed                          # coins, networks, verification levels, default settings
npm run create-admin -- --email you@example.com    # the first owner; prints the password once
npm run start:dev
```

- API: http://localhost:3000. Health check: `GET /health`.
- Browsable API with a Try-it-out button: http://localhost:3000/docs.
- The admin dashboard runs separately (its own repository) on port 3100.

---

## Settings: three places

| Where | What | Who changes it |
|---|---|---|
| **`.env`** (only on the server) | The "keys to the house": `DATABASE_URL`, Redis, `JWT_*` secrets, `CREDENTIALS_KEY`, `KYC_HASH_KEY`, provider web addresses, the `*_USE_MOCK` switches, `NODE_ENV`, `PORT`, `TRUST_PROXY_ADDRESSES` | The server administrator; needs a restart |
| **Dashboard → System → API keys** | Partner secrets (Quidax, Payrep, Dojah, R2 keys, SMTP password, Firebase key), stored encrypted with `CREDENTIALS_KEY` | Owners; applies within 60 s |
| **Dashboard → System → Server settings** | 32 everyday settings: naira switches, Payrep main account, email confirmation, mail server, quote lifetime, fees, session lengths, Quidax speed limits, R2 bucket… (`src/settings/server-settings.registry.ts`) | Owners, with password + reason; audited; applies within ~10 s |

The full annotated list is in [`.env.example`](.env.example). The `.env` value is the starting value for anything on the Server settings screen; a value saved on the screen wins. `TRADING_ENABLED` and the old `MAX_*_USD` caps are retired: trading is halted from the dashboard, and limits are set per verification level.

---

## Rules the code depends on

Each exists because its absence causes a class of incident.

1. **No floats for money.** Prisma `Decimal` over Postgres `NUMERIC(38,18)`, end to end.
2. **The ledger is append-only.** `LedgerEntry` is never updated or deleted; `Balance` is a projection; corrections are compensating entries.
3. **Lock before calling out.** Money moves `available → locked` in the same database step that writes the pending row, before any network request.
4. **An unclear result is never a failure.** A timeout or an unknown answer from Quidax or Payrep puts the transaction in `RECONCILING`; the money stays locked and a job asks the provider. **Never retry blind; never refund from `RECONCILING`.**
5. **Refund only on a clear "no".**
6. **Never trust a provider's message.** Every Quidax and Payrep money message is checked against the provider's own record before anything is credited or refunded.
7. **Every write is idempotent.** The app sends `Idempotency-Key`; we send providers a unique reference.
8. **Rate configs are versioned** (insert a new row, never update), so a dispute can be answered with the rates live at that moment.

---

## Project layout

```
prisma/schema.prisma   data model (read this first)
src/
  auth/ users/         sign-up, sign-in, email code, sessions
  kyc/ dojah/ compliance/ levels/   verification (Basic, Advanced), AML review, limits per level
  quidax/              the ONLY code that talks to Quidax (+ quidax.mock.ts)
  payrep/ naira-rail/ ngn-deposits/ treasury/   naira through Payrep
  addresses/ deposits/ withdrawals/ trades/ quotes/ rates/   crypto money flows
  ledger/              the only code that writes balances
  giftcards/ referrals/ fees/ inventory/ reconciliation/
  settings/            Server settings screen + "sign out all customers"
  admin/               dashboard routes, permissions, audit log
  storage/             R2 file storage
  common/ config/      shared helpers; env validation (refuses to boot if anything is off)
scripts/               create-admin, seed helpers, provider checks, prove-* race tests
deploy/                VPS set-up and release scripts (PM2)
docs/                  app developer guides (below)
test/e2e/              end-to-end tests over real HTTP
```

---

## Scripts

| Command | Does |
|---|---|
| `npm run start:dev` | Watch mode (frees port 3000 first; Ctrl+C doesn't always stop node on Windows) |
| `npm run stop` | Free a port held by a stale server |
| `npm run build` / `npm run start:prod` | Compile / run the compiled API |
| `npm test` | Unit tests (2,022 on 27 Oct) |
| `npm run start:e2e -- 3002` then `npm run test:e2e` | End-to-end tests on a test server (194 on 27 Oct). See `test/e2e/README.md`; a second test server needs `REDIS_PORT=6380` |
| `npm run create-admin -- --email …` | The first owner, or reset a lost owner password |
| `npm run seed` | Starting data (safe to run once on a new database) |
| `npm run dev-credit` | Credit a balance locally (development only) |
| `npm run check:payrep` / `check:dojah-advanced` / `check:r2` | One-off checks against a provider's sandbox or bucket. **Run only with the owner's OK.** |
| `npm run email:preview` | Render every email to files (refuses to send on a live server) |
| `npx ts-node --transpile-only --compiler-options '{"module":"CommonJS"}' scripts/route-inventory.ts > docs/ROUTE_INVENTORY.md` | Regenerate the route list |

---

## Deploying

PM2 on a VPS: `ecosystem.config.js` (this repo and the dashboard's), `deploy/setup-server.sh` (one time) and `deploy/deploy.sh` (each release: pull, install, build, migrate, restart, health check). The step-by-step guide is `PM2_VPS_GUIDE.md` in the project's Reports folder.

### The Quidax key and webhook

1. Sign in at https://pro.quidax.io with the **business** account → user icon → **API management** → create the key (allow-list the server IP).
2. Put it on **System → API keys** (or `QUIDAX_SECRET_KEY` in `.env`) and set `QUIDAX_USE_MOCK=false`.
3. Webhook: **API Management → Webhook Configuration**, callback `https://<API>/webhooks/quidax`, HMAC SHA256, a strong secret; the same secret goes in as the Quidax webhook secret.
4. **There's one webhook URL per Quidax account**, so dev and production can't both receive events.
5. **Sub-account emails are permanent.** Real users get `u_<id>@users.davochain.com`, test accounts `t_<id>@test.davochain.com`; Quidax can't delete sub-accounts.

### Payrep and Dojah

Live set-up steps: `LAUNCH_CHECKLIST.md` and `PAYREP_INTEGRATION_PLAN.md` section 9 (Reports folder).

---

## Documentation

| Document | For |
|---|---|
| [`docs/FLUTTER_API.md`](docs/FLUTTER_API.md) | The mobile app developer: every customer endpoint, errors, pushes, Dart examples |
| [`docs/CUSTOMER_JOURNEY_API_GUIDE.md`](docs/CUSTOMER_JOURNEY_API_GUIDE.md) + [`docs/postman/`](docs/postman/) | One customer through the whole app, with real responses; a Postman collection |
| [`docs/ROUTE_INVENTORY.md`](docs/ROUTE_INVENTORY.md) | Every route, its auth, permission and rate limit (generated), plus recent changes |
| [`docs/API_TESTING_GUIDE.md`](docs/API_TESTING_GUIDE.md) | Testing the API by hand |
| [`test/e2e/README.md`](test/e2e/README.md) | Running the end-to-end tests |
| Reports folder (in the project workspace) | Plain-language flows, the launch checklist, open issues, the handover overview (`HANDOVER.md`) |
