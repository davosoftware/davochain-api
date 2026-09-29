# Davochain Backend

NestJS + Prisma + Postgres + Redis. Sits on top of the Quidax Open API.

Design guide (the "why" behind every decision here): **https://claude.ai/code/artifact/21298075-e0ed-4265-b05a-6adba34ee7ab**

---

## The one thing to know before you start

**Quidax has no sandbox.** One base URL, one key, real money from the first call.

Everything below follows from that: you develop against a built-in mock, the live key lives in exactly one place, and non-production processes must never hold it. `QUIDAX_USE_MOCK=true` is the default, and the app **refuses to boot** in production with it still on.

---

## Quick start

```bash
# 1. Install
npm install

# 2. Start Postgres + Redis
docker compose up -d          # or point DATABASE_URL / REDIS_* at your own

# 3. Configure
cp .env.example .env
#    Fill in the three JWT secrets (see below). Leave QUIDAX_USE_MOCK=true.

# 4. Create the schema
npx prisma migrate dev --name init
npx prisma generate
npm run seed              # 15 assets, gates, KYC tiers, kill switches

# 5. Run
npm run start:dev
```

Then open **http://localhost:3000/docs** — every endpoint, browsable, with a
Try it out button. Log in via `/v1/admin/auth/login`, copy the token, click
**Authorize**, and you can drive the whole system from the browser.

And `GET http://localhost:3000/health` should return:

```json
{ "status": "ok", "database": "up", "quidax": "mock", "env": "development" }
```

### Generating the secrets

`JWT_SECRET`, `JWT_REFRESH_SECRET` and `ADMIN_JWT_SECRET` must each be 32+ characters. The app will not start otherwise.

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Run it three times, one per secret. Use **different** values — a leaked user token must not be usable against the admin surface.

---

## Getting your Quidax key

1. Sign in at **https://pro.quidax.io** with your **business** account.
2. Click your username in the nav bar → the user icon.
3. Open the **API management** tab.
4. Optionally enter an IP address to allowlist (recommended — this key controls the whole treasury), enter your authentication code, and click **Create**.
5. Copy the key into `.env`:

```bash
QUIDAX_SECRET_KEY=your_key_here
QUIDAX_USE_MOCK=false
```

The client sends it as `Authorization: Bearer <key>`. You never handle that header yourself — `QuidaxClient` is the only thing in the codebase that talks to Quidax.

> **The key controls the entire treasury.** Not in `.env.example`, not in git, not in CI, not on a laptop. Production secret store only. Turn on IP allowlisting in the dashboard.

### Setting up the webhook

Same dashboard: **API Management → Webhook Configuration**.

| Field | Value |
| --- | --- |
| Callback URL | `https://your-domain.com/webhooks/quidax` |
| Signature type | HMAC SHA256 |
| Signature secret | any strong random string |

Put that same secret in `.env` as `QUIDAX_WEBHOOK_SECRET`.

**There is only one webhook URL per merchant account.** Dev, staging and production cannot all receive events. Point it at production and have the receiver fan out a verified copy to non-production endpoints; local development replays rows out of the `webhook_events` table. (Worth asking Quidax whether a second merchant account can be issued for staging — that is the only clean fix.)

Signature verification happens over the **raw request bytes**. `main.ts` creates the app with `rawBody: true` for exactly this reason — Nest's body parser re-serialises JSON, and re-stringifying does not reproduce the original bytes, so HMAC comparison would fail silently on every event.

---

## Environment reference

Full annotated list in [`.env.example`](.env.example). The ones that matter most:

| Variable | Why it matters |
| --- | --- |
| `QUIDAX_SECRET_KEY` | Controls the treasury. Required when `QUIDAX_USE_MOCK=false`. |
| `QUIDAX_WEBHOOK_SECRET` | Must match the dashboard exactly or every webhook is rejected. |
| `QUIDAX_USE_MOCK` | `true` everywhere except production. Enforced at boot. |
| `QUIDAX_RATE_LIMIT_PER_MINUTE` | 300/min is a **shared** budget across prod, staging, admin and any dev process on the live key. Default 240 leaves headroom. |
| `QUIDAX_BACKGROUND_RATE_LIMIT_PER_MINUTE` | Separate lane so a fee-claim run can never starve live trading. |
| `QUOTE_TTL_SECONDS` | 12. Must stay under 15 — that is when a Quidax quotation dies. Validated at boot. |
| `RATE_CACHE_TTL_SECONDS` | 3. Collapses a thousand users watching BTC into ~20 upstream calls a minute. |
| `USER_ALIAS_EMAIL_DOMAIN` / `TEST_ALIAS_EMAIL_DOMAIN` | See below — this one is irreversible. |
| `TRADING_ENABLED`, `MAX_*` | Kill switches and caps. Ship with the brakes on; there is no rollback on live. |

### The email alias scheme is irreversible

Quidax sub-account emails are **unique and immutable**, and there is **no delete endpoint**. Every signup permanently burns an address on your live merchant account.

So: real users get `u_<uuid>@users.davochain.com`, test accounts get `t_<uuid>@test.davochain.com`. Decide this before the first test signup — those rows will sit in your reporting forever, and the prefix is the only way to filter them out.

---

## Project layout

```
prisma/schema.prisma     data model — read this first, it is the spec
src/
  config/                env validation; the app refuses to boot if anything is off
  common/money.ts        Decimal helpers, rounding rules, minimum calculation
  prisma/                PrismaService, incl. serializable() for money paths
  quidax/
    quidax.client.ts     the ONLY thing that talks to Quidax
    quidax.mock.ts       fixture-backed stand-in (no sandbox exists)
    quidax.errors.ts     Error vs RateLimit vs UNKNOWN — the distinction matters
    rate-limiter.ts      token buckets + single-flight coalescing
  ledger/                the only thing that writes to `balances`
  assets/ users/ addresses/ rates/ quotes/ trades/
  withdrawals/ webhooks/ inventory/ fees/ notifications/ admin/ auth/
```

---

## Rules the code depends on

These are not style preferences. Each one exists because its absence is a class of incident.

1. **No floats.** Prisma `Decimal` over Postgres `NUMERIC(38,18)`, end to end. Never `.toNumber()` a balance. Quidax returns strings — keep them strings until they hit a Decimal.
2. **The ledger is append-only.** `LedgerEntry` is never updated or deleted. `Balance` is a projection. Corrections are compensating entries.
3. **Lock before you call out.** Funds move `available → locked` in the same transaction that writes the pending row, before any network request. Otherwise a user spends the same balance twice by tapping quickly.
4. **Timeouts are UNKNOWN, not failed.** A confirm or transfer that times out throws `QuidaxUnknownError`. The transaction goes to `RECONCILING`, funds stay locked, and a worker polls Quidax for the truth. **Never retry blind, never refund from `RECONCILING`.**
5. **Refund only on `FAILED`.** Never on `PENDING`, never on `RECONCILING`.
6. **Round the user's entitlement down, always** — and price the trade from the rounded amount, so nothing evaporates. See `floorToStep` in `common/money.ts`.
7. **Every write is idempotent.** Client sends `Idempotency-Key`; we send Quidax a unique `reference`. A replay returns the original result.
8. **Rate configs are versioned.** Insert a new row, never `UPDATE`. A dispute six weeks out has to be answerable with the gate that was live at that moment.

---

## First live calls — measure, don't assume

Two numbers are not documented anywhere and both change code. Run these once against the live key, in staging, with tiny amounts, and write the results into `assets`:

**1. Transfer step per coin.** How many decimals a transfer will actually move. Send an amount with more decimals than you expect is allowed and record whether Quidax errors, rounds, or accepts. **Check Bitcoin first, then Ethereum** — step size is denominated in dollars, so the expensive coins have the coarsest steps.

**2. Confirm → complete latency on a swap.** `confirmSwap` returns `status: "initiated"`. The documented examples suggest completion lands within the same second, in which case a short poll makes swaps feel instant and no elaborate progress flow is needed. Instrument it before designing around it.

Known limits are already seeded in the mock (`quidax.mock.ts`), including the published internal-transfer minimums — BTC `0.00015` (≈ $15, **above** a $10 floor), USDT `1`, NGN `1`.

---

## Scripts

| Command | Does |
| --- | --- |
| `npm run start:dev` | Watch mode. Frees port 3000 first — Ctrl+C does not always kill node on Windows |
| `npm run stop` | Kill a stale server holding the port |
| `npm run create-admin` | Create an admin account — nothing else can reach /v1/admin |
| `npm run dev-credit` | Credit a balance locally (stands in for the missing funding provider) |
| `npm run demo` | Walk the whole buy path: register → KYC → fund → quote → trade |
| `npm run build` / `start:prod` | Compile / run compiled |
| `npm run prisma:migrate` | Create + apply a migration |
| `npm run prisma:studio` | Browse the database |
| `npm test` | Jest |
| `npm run lint` / `format` | ESLint / Prettier |

---

## Status

Built, wired and booting — see **[STATUS.md](../docs/STATUS.md)** for the full API surface
and what is still outstanding.

| | |
| --- | --- |
| [ARCHITECTURE.md](../docs/ARCHITECTURE.md) | How the pieces fit, the money flows, their failure modes |
| [FLUTTER.md](../docs/FLUTTER.md) | Endpoints, auth and refresh rules, the 12-second quote contract |
| [TODO.md](../docs/TODO.md) | Running work list, open questions, what to measure live |
