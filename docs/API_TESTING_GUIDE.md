# DavoChain API: personal testing guide

A hands-on guide for testing the API yourself from a terminal, using `curl` (Git Bash on Windows works).

**Every example response in this guide was captured from a real run on 14 October 2026** (local server, provider mocks). IDs, tokens and times will differ on your machine.

**Companion documents:**

| File | What it gives you |
|---|---|
| [`ROUTE_INVENTORY.md`](ROUTE_INVENTORY.md) | **All 186 routes**, generated from the code. For each: method, path, who may call it, KYC, admin permission, rate limit, whether it pauses in maintenance, and every request-body field with its validation rules. Regenerate with `npx ts-node --transpile-only --compiler-options '{"module":"CommonJS"}' scripts/route-inventory.ts > docs/ROUTE_INVENTORY.md`. |
| [`CUSTOMER_JOURNEY_API_GUIDE.md`](CUSTOMER_JOURNEY_API_GUIDE.md) | **New 23 Oct:** the whole customer journey in order, with real responses, token refresh, and a Postman collection (`postman/`) that refreshes tokens by itself |
| [`FLUTTER_API.md`](FLUTTER_API.md) | The app team's guide: every user endpoint in depth, with every error message |
| `http://localhost:3000/docs` | Swagger, when the server runs outside production: try requests in the browser |
| `npm run test:e2e` | Automated versions of the checks below (section 10) |

---

## 1. Start a server you can test against

You need Postgres and Redis running (`docker compose up -d` at the workspace root), and the database migrated (`cd api && npx prisma migrate deploy`).

Start the API with every outside provider **mocked**, so nothing real is called or charged. Use this instead of `npm run start:dev`; it works in PowerShell, cmd and Bash:

```
cd api
npm run start:e2e
```

It sets these for you:

| Variable | Why |
|---|---|
| `DOJAH_USE_MOCK=true`, `KYC_BASIC_ENABLED=true` | Basic verification works, with the test numbers in section 5 |
| `QUIDAX_USE_MOCK=true`, `FLW_USE_MOCK=true` | Crypto and naira providers are simulated |
| `ALERT_DEFAULT_RECIPIENTS` | Basic verification only runs when someone receives AML alerts |
| `RATE_LIMIT_AUTH_REGISTER_IP=1000/1h` | Lets you create many test users. The real limit is 5 per hour per IP. |

Check it is up:

```bash
curl -s http://localhost:3000/health
```

```json
{"status":"ok","database":"up","quidax":"mock","env":"development","time":"2026-10-14T16:12:03.220Z"}
```

**Create an admin** (for section 9):

```bash
npm run create-admin -- --email you@example.com --password 'pick-a-long-password-9'
```

**Set these in your terminal once.** All the examples use them. The `curl` examples are written for **Git Bash**; in PowerShell use `curl.exe` and its own quoting, or simply use Git Bash for this guide.

```bash
API=http://localhost:3000/v1
EMAIL="tester-$RANDOM@example.com"
PASSWORD='Test-password-123'
```

---

## 2. Rules that apply to every request

| Rule | Detail |
|---|---|
| **Base URL** | `http://localhost:3000/v1/...`. Exceptions with no `/v1`: `/health`, `/webhooks/quidax`, `/webhooks/flutterwave`. |
| **Body** | JSON, with header `Content-Type: application/json` |
| **User login** | Header `Authorization: Bearer <accessToken>` (from register or login). Lasts 15 minutes; use refresh (3.4) for a new one. |
| **Admin login** | Header `Authorization: Bearer <admin accessToken>` from `POST /v1/admin/auth/login`. A user token never works on `/v1/admin/...`. |
| **Idempotency-Key** | **Required** on `POST /v1/trades`, `POST /v1/withdrawals/crypto`, `POST /v1/withdrawals/ngn`. Any unique string (a UUID). Sending the same key again returns the **same** result instead of doing it twice. |
| **Money** | Always **strings** (`"50000"`, `"0.00032893"`), never numbers |
| **Unknown fields** | Refused with 400 (`property x should not exist`) |
| **Rate limits** | Over the limit: `429` with a `Retry-After: N` header. Limits per route: `ROUTE_INVENTORY.md`, "Rate limit" column. |

**Error format.** `message` is a string, or a list when several fields fail:

```json
{"message":"Incorrect email or password","error":"Unauthorized","statusCode":401}
{"message":["Enter a valid email address","Password must be at least 10 characters"],"error":"Bad Request","statusCode":400}
```

**Special 403/503 bodies** carry a `code` instead:

| Body | When |
|---|---|
| `{"message":"Verification required before you can do this","requiredTier":"TIER_1","currentTier":"TIER_0","kycStatus":"NOT_STARTED"}` | Not verified |
| `{"code":"VERIFICATION_PENDING","message":"Your verification is still being completed."}` | Basic still finishing |
| `{"code":"ACCOUNT_UNDER_REVIEW","message":"Your account is under review. Contact support."}` | Under compliance review, restricted or blocked |
| `{"code":"ACCOUNT_SUSPENDED", …}` / `{"code":"ACCOUNT_CLOSED", …}` | Account suspended or closed |
| `{"statusCode":503,"code":"MAINTENANCE","message":"<admin's message>"}` | Maintenance mode is on (money-moving routes only) |

| Status | Meaning |
|---|---|
| 200 / 201 | Success (201 = something was created) |
| 202 | Accepted, still finishing (naira account opening) |
| 400 | Your request is wrong; nothing happened |
| 401 | Missing, expired or wrong token / password |
| 403 | Not allowed (KYC, permission, account state, feature switched off) |
| 404 | Not found, or not yours |
| 409 | Conflict (already done, already in progress) |
| 429 | Rate limited: wait `Retry-After` seconds |
| 503 | Temporarily unavailable (provider down, maintenance, feature not ready) |

---

## 3. Accounts and login

### 3.1 Register

`POST /v1/auth/register` · no token · rate limit `auth.register` (5/hour per IP)

| Field | Required | Rules |
|---|---|---|
| `email` | yes | a valid email, max 254 |
| `password` | yes | 10–128 characters, at least one letter and one number |
| `firstName`, `lastName` | yes | 1–60 characters |
| `phone` | **yes** | `+` optional, then 7–15 digits; must be unused |
| `referralCode` | no | max 16; an unknown code is ignored |

```bash
curl -s -X POST $API/auth/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"firstName\":\"Someone\",\"lastName\":\"Clean\",\"phone\":\"+2348012$RANDOM\"}"
```

**201:**

```json
{"accessToken":"eyJhbGciOiJI…","refreshToken":"2_ydljQK8VWe…","expiresIn":"15m","userId":"d4ee527d-466a-4897-8207-8a058b9d6e8e"}
```

| Error | Response |
|---|---|
| Email or phone already used | 400 `"Unable to register with those details"` (deliberately doesn't say which) |
| Invalid fields | 400 with a list, e.g. `["Enter a valid email address","Password must be at least 10 characters", …]` |
| Too many sign-ups from your IP | 429 `"Too many attempts. Try again in N seconds."` |

### 3.2 Log in and keep the token

`POST /v1/auth/login` · no token · rate limit `auth.login` (20/15 min per IP, 10/15 min per email)

```bash
TOKEN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')
echo $TOKEN
```

**200:**

```json
{"accessToken":"eyJhbGciOiJI…","refreshToken":"VdJWbL46d4aJ…","expiresIn":"15m"}
```

| Error | Response |
|---|---|
| Wrong email or password | 401 `"Incorrect email or password"` |
| 5 wrong passwords in a row | 403 `"Too many failed attempts. Try again after <time>"` (15-minute lock) |
| Suspended / closed | 403 with `code: "ACCOUNT_SUSPENDED"` / `"ACCOUNT_CLOSED"` |

### 3.3 Who am I

```bash
curl -s $API/auth/me -H "Authorization: Bearer $TOKEN"
curl -s $API/me -H "Authorization: Bearer $TOKEN"
```

`GET /v1/me`, **200:**

```json
{"id":"d4ee527d-…","email":"docs-a6b2b7@davochain.invalid","firstName":"Someone","lastName":"Clean","phone":"+2348594323151","status":"ACTIVE","kyc":{"tier":"TIER_0","status":"NOT_STARTED","rejectionReason":null,"submittedAt":null},"walletReady":true,"createdAt":"2026-10-14T16:12:03.405Z"}
```

Without a token: 401 `{"message":"Missing bearer token","error":"Unauthorized","statusCode":401}`.

### 3.4 Refresh, log out, change password, reset password

| Call | Body | Notes |
|---|---|---|
| `POST /v1/auth/refresh` | `{"refreshToken":"…"}` | Returns a **new pair**. The old refresh token stops working (single use). |
| `POST /v1/auth/logout` (token) | `{"refreshToken":"…"}` | Ends that session |
| `POST /v1/auth/change-password` (token) | `{"currentPassword":"…","newPassword":"…"}` | Signs out every session. Limit 5/hour. |
| `POST /v1/auth/reset/request` | `{"email":"…"}` | Always 200, even for an unknown email (no account fishing). The code goes by email. |
| `POST /v1/auth/reset/confirm` | `{"email":"…","code":"123456","newPassword":"…"}` | Code: 6 digits, 10 minutes, 5 tries |

Exact field names: `ROUTE_INVENTORY.md`.

---

## 4. Wallets and profile

```bash
curl -s $API/wallets -H "Authorization: Bearer $TOKEN"
```

**200:** one entry per coin (only the first two shown):

```json
[{"asset":"ngn","name":"Nigerian Naira","isFiat":true,"available":"0.00","locked":"0.00","total":"0.00"},
 {"asset":"btc","name":"Bitcoin","isFiat":false,"available":"0.00000000","locked":"0.00000000","total":"0.00000000"}]
```

- `available`: what can be spent now.
- `locked`: reserved for something in progress.

**Give yourself test naira** (development only; refuses in production):

```bash
npm run dev-credit -- --email $EMAIL --asset ngn --amount 200000
```

---

## 5. Basic verification (KYC)

### 5.1 Status

```bash
curl -s $API/kyc -H "Authorization: Bearer $TOKEN"
```

**200**, before verifying:

```json
{"tier":"TIER_0","status":"NOT_STARTED","rejectionReason":null,"submittedAt":null,"bvnLast4":null,"documents":[],
 "level":"NONE","basicState":null,"underReview":false,"attemptsLeftToday":3,"attemptsLeftTotal":10,
 "limits":{"current":{"deposit":{"singleNgn":"0.00","dailyNgn":"0.00","usedTodayNgn":"0.00","remainingTodayNgn":"0.00"},"withdraw":{…}},"tiers":[…]}}
```

### 5.2 States and LGAs (public)

```bash
curl -s $API/kyc/states
```

```json
{"states":[{"name":"Abia","lgas":["Aba North","Aba South", …]},{"name":"Adamawa","lgas":[…]}, …]}
```

There are 37 entries (36 states plus `FCT`) and 774 LGAs in total.

### 5.3 Submit

`POST /v1/kyc/basic` · token · rate limit `kyc.basic` (5/hour per user) · paused in maintenance

| Field | Required | Rules |
|---|---|---|
| `idType` | yes | `BVN` or `NIN` |
| `idNumber` | yes | exactly 11 digits |
| `firstName`, `lastName` | yes | letters (accents allowed), `'`, `-`, `.`, spaces; max 60 |
| `middleName` | no | same rules |
| `dateOfBirth` | yes | `YYYY-MM-DD` |
| `address.street` / `.city` | yes | max 200 / 80 |
| `address.state`, `address.lga` | yes | from 5.2 |
| `address.postcode` | no | 6 digits |
| `stateOfOrigin` | yes | from 5.2 |
| `country` | yes | `NG` |

```bash
curl -s -X POST $API/kyc/basic -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "idType":"BVN","idNumber":"33333333333","firstName":"Someone","lastName":"Clean","dateOfBirth":"1995-03-03",
  "address":{"street":"1 Test Street","city":"Ikeja","state":"Lagos","lga":"Ikeja"},
  "stateOfOrigin":"Lagos","country":"NG"}'
```

**201:**

```json
{"state":"APPROVED","level":"BASIC","message":"You are verified."}
```

**Log in again after approval.** Your sessions are ended on purpose, so the new level takes effect.

**Test numbers** (the Dojah mock only):

| `idNumber` | Type these names / date of birth | Result |
|---|---|---|
| `33333333333` | Someone Clean, 1995-03-03 | `APPROVED` |
| `33333333333` | any other name | `IDENTITY_REVIEW` (a person must decide) |
| `44444444444` | Test Clean, 1980-12-13 (wrong date) | `IDENTITY_REVIEW` |
| `22222222222` | John Doe Ajayi, 2000-05-01 | `COMPLIANCE_REVIEW` (AML "Unknown" + PEP) |
| `66666666666` | Test Sanctioned, 1985-06-06 | `COMPLIANCE_REVIEW`, and the account is **blocked** (sanctions) |
| `77777777777` | Test Maybesanctioned, 1985-06-06 | `COMPLIANCE_REVIEW` (possible sanctions) |
| `11111111111` | anything | `REJECTED_NOT_FOUND` (uses an attempt) |
| `40100000001` / `40300000001` / `40200000001` / `50000000001` / `99999999999` | anything | 503 (provider problems; no attempt used) |

| Error | Response |
|---|---|
| Invalid fields | 400 list, e.g. `["BVN and NIN are 11 digits","Enter your first name as it appears on your ID", …]` |
| State/LGA not on the list | 400 `"Choose your state and LGA from the list"` |
| A submission already in progress or under review | 409 `"A verification is already in progress."` |
| Already verified | 409 `"You are already verified."` |
| Under review / blocked | 403 `"Your account is under review. Contact support."` |
| 3 today / 10 in total | 429 `"You have reached today's verification limit…"` / `"You have used all your verification attempts…"` |
| Basic switched off | 503 `"Verification is not available yet."` |
| Provider not ready | 503 `"Verification is temporarily unavailable. Please try again later."` |

---

## 6. Trading (buy, sell, swap)

Needs: Basic approved, AML clear, and a balance (`dev-credit` in section 4).

### 6.1 Quote

`POST /v1/quotes` · token · KYC Basic · paused in maintenance

| Field | Rules |
|---|---|
| `side` | `buy`, `sell` or `swap` |
| `fromAsset`, `toAsset` | coin codes, e.g. `ngn`, `btc`, `usdt` |
| `amount` | a number as a string, in `fromAsset` |

```bash
QUOTE=$(curl -s -X POST $API/quotes -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"side":"buy","fromAsset":"ngn","toAsset":"btc","amount":"50000"}')
echo $QUOTE
QUOTE_ID=$(echo $QUOTE | node -pe 'JSON.parse(require("fs").readFileSync(0)).quoteId')
```

**201:**

```json
{"quoteId":"b2d7cf52-b0be-4b1c-96c7-7d8932cb2f48","side":"BUY","fromAsset":"ngn","toAsset":"btc","fromAmount":"49999.99","toAmount":"0.00032893",
 "rate":"1475.8032","fee":"0.00000000","feeAsset":null,"minimum":"18.54","maximum":"2000.00",
 "expiresAt":"2026-10-14T16:12:16.570Z","ttlSeconds":12,"availableBalance":"200000.00"}
```

**A quote lasts 12 seconds and can be used once.**

| Error | Response |
|---|---|
| Not verified | 403 with `requiredTier` |
| Not enough balance | 400 `"Insufficient USDT balance. You have 0.000000."` |
| Bad amount | 400 `["amount must be a number string"]` |
| Below/above a coin's transfer limit | 400 `"Minimum BTC transfer is 0.00015"` |
| Trading paused | 403 `"Trading is temporarily paused. Please try again shortly."` |

### 6.2 Execute the trade

`POST /v1/trades` · token · KYC Basic · **Idempotency-Key required** · paused in maintenance

```bash
KEY=$(node -e 'console.log(crypto.randomUUID())')
curl -s -X POST $API/trades -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" -d "{\"quoteId\":\"$QUOTE_ID\"}"
```

**201:**

```json
{"transactionId":"a2453501-7854-447a-b403-9f93981f0433","status":"COMPLETED","fromAsset":"ngn","fromAmount":"50000.00","toAsset":"btc","toAmount":"0.00032893","rate":"1475.8032"}
```

**What to test:**
- **The same key again** gives the **same** answer, and nothing is traded twice.
- **No key:** 400 `"Idempotency-Key header is required for this request"`.
- **An expired or used quote:** 400.

### 6.3 History

```bash
curl -s "$API/trades?limit=5" -H "Authorization: Bearer $TOKEN"
curl -s $API/trades/<transactionId> -H "Authorization: Bearer $TOKEN"
```

```json
[{"id":"a2453501-…","type":"BUY","status":"COMPLETED","fromAsset":"ngn","fromAmount":"50000","toAsset":"btc","toAmount":"0.000328930638567976","rate":"1475.8032","fee":"0","reason":null,"createdAt":"…","completedAt":"…"}]
```

Afterwards `GET /v1/wallets` shows `ngn` 150000.00 and `btc` 0.00032893.

---

## 7. Deposits

| Call | Example / result |
|---|---|
| `GET /v1/assets` | coins and their networks |
| `GET /v1/assets/btc/networks` | `[{"id":"btc","label":"Bitcoin Network","requiresTag":false,"confirmations":2,"isDefault":true}]` |
| `POST /v1/deposits/address` (token, KYC Basic) | body `{"asset":"btc","network":"btc"}`. Returns 201 with `status:"PENDING"`, `address:null` at first; the address arrives a moment later. Poll `GET /v1/deposits/addresses` until `usable:true`. |
| `GET /v1/deposits` | deposit history |
| `GET /v1/deposits/ngn/account` | your naira account, or 404 `{"code":"NO_VIRTUAL_ACCOUNT","eligible":false,"reason":"Naira deposits are not available yet.", …}` |
| `POST /v1/deposits/ngn/account` (KYC Basic and AML clear) | body `{"bvn":"…"}` or `{"nin":"…"}`. Must match the number you verified with. |

---

## 8. Withdrawals

### 8.1 Fee quotes (no KYC needed)

```bash
curl -s "$API/withdrawals/quote?asset=btc&amount=0.0002&network=btc" -H "Authorization: Bearer $TOKEN"
```

```json
{"asset":"btc","network":"btc","amount":"0.00020000","networkFee":"0.00020000","platformFee":"0.00000000","platformFeeUsd":"0.00","totalFee":"0.00020000","totalDeducted":"0.00040000","youReceive":"0.00020000"}
```

```bash
curl -s "$API/withdrawals/quote/ngn?amount=5000" -H "Authorization: Bearer $TOKEN"
```

```json
{"asset":"ngn","amount":"5000.00","feeNgn":"0.00","totalDebited":"5000.00","youReceive":"5000.00","band":null,"feeConfigured":false,
 "limit":{"allowed":false,"reason":"Your account cannot withdraw naira yet. Complete the next verification tier to unlock it.", …},"payoutAvailable":false}
```

| Error | Response |
|---|---|
| Missing or bad `amount` | 400 `"Enter an amount greater than zero"` |
| Missing `asset` / `network` (crypto) | 400 `"Choose a coin"` / `"Choose a network"` |

### 8.2 Withdraw

| Call | Body | Notes |
|---|---|---|
| `POST /v1/withdrawals/crypto` | `{"asset":"btc","network":"btc","amount":"0.0002","address":"…"}` (plus `destinationTag` on networks that need one) | Idempotency-Key required, KYC Basic |
| `GET /v1/withdrawals/ngn/banks` | — | 403 while naira withdrawals are switched off |
| `POST /v1/withdrawals/ngn/verify-account` | `{"accountNumber":"0123456789","bankCode":"044"}` | Returns the account holder's name |
| `POST /v1/withdrawals/ngn` | `{"amount":"5000","accountNumber":"…","bankCode":"…"}` | Idempotency-Key required. Wrong bank details: 400; bank check down: 503. Nothing is debited either way. |
| `GET /v1/withdrawals` | — | history |

**Naira withdrawals are off by default** (403 `"Naira withdrawals are temporarily unavailable."`). An owner switches them on in the dashboard. Limits per level are ₦0 until set.

---

## 9. Other user routes

| Call | Notes |
|---|---|
| `GET /v1/notifications` | `{"unread":1,"items":[{"type":"trade.completed","title":"Bought 0.00032893 BTC","body":"Rate: ₦1475.80 per $1", …}]}` |
| `POST /v1/notifications/read` | mark notifications read |
| `GET /v1/referrals/me`, `PUT /v1/referrals/username`, `GET /v1/referrals/code/:code` | referral code, link, offer, totals |
| `GET /v1/site` (public) | company info, app versions, **`maintenance: {active, message}`**, socials |
| `GET /v1/content/pages`, `/pages/:slug`, `/faqs` (public) | CMS content |
| `GET /v1/giftcards/catalogue`, `POST /v1/giftcards/trades`, `GET /v1/giftcards/trades[/:id]` | gift cards (an empty catalogue until an admin adds brands) |
| `POST /v1/devices`, `GET /v1/devices`, `DELETE /v1/devices` | push-notification device tokens |

---

## 10. Admin

### 10.1 Log in

`POST /v1/admin/auth/login` · rate limit `auth.login`

```bash
ADMIN=$(curl -s -X POST $API/admin/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"pick-a-long-password-9"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')
curl -s $API/admin/me -H "Authorization: Bearer $ADMIN"
```

**200:**

```json
{"id":"29a6ba39-…","email":"docs-owner@davochain.invalid","name":"Administrator","isActive":true,"role":"OWNER","permissions":["overview.view","inventory.view", …],
 "idleTimeoutMs":1800000,"idleRemainingMs":1799987,"permissionCatalogue":[…]}
```

| Error | Response |
|---|---|
| No token | 401 `"Missing admin token"` |
| Wrong password (or locked after 5 tries; same answer on purpose) | 401 |
| Missing permission (sub-admins) | 403 |

**Owners have every permission.** Sub-admins only have what an owner granted (the "Admin permission" column in `ROUTE_INVENTORY.md`).

### 10.2 The admin routes you'll use most

| Call | Permission | What it shows / does |
|---|---|---|
| `GET /v1/admin/users?limit=20` | `users.view` | users with KYC level and status |
| `GET /v1/admin/transactions?limit=20` | `transactions.view` | every transaction, with its settlement legs |
| `GET /v1/admin/kyc/pending` | `kyc.view` | KYC queue; Basic rows carry the typed-vs-record comparison |
| `POST /v1/admin/kyc/:userId/basic-decision` | `kyc.review` | `{"approve":true,"reason":"at least 10 characters"}` |
| `GET /v1/admin/compliance/cases?filter=open` | `compliance.view` | AML cases, sanctions first |
| `GET /v1/admin/compliance/cases/:id` | `compliance.view` | one case (opening it is audited) |
| `POST /v1/admin/compliance/cases/:id/decide` | `compliance.review` | `{"decision":"CLEARED","reason":"…"}`. Sanctions cases: owner only, `SANCTIONS_CONFIRMED` (with `reportedToAuthority`) or `SANCTIONS_FALSE_POSITIVE` (a proposal) |
| `POST /v1/admin/compliance/cases/:id/confirm` | `compliance.review` | `{"confirm":true,"reason":"…"}`. Must be a **different** admin from the proposer. |
| `GET /v1/admin/dojah/readiness?refresh=true` | `settings.manage` | whether Basic can run |
| `GET /v1/admin/dojah/unknown-calls` | `settings.manage` | Dojah calls to check against the bill |
| `GET` / `POST` / `PATCH` / `DELETE /v1/admin/alert-recipients` | `alerts.manage` | who gets alert emails |
| `PUT /v1/admin/site-settings` | `settings.manage` | e.g. `{"maintenanceMode":true,"maintenanceMessage":"Back by 2pm."}` |
| `GET /v1/admin/audit` | `audit.view` | the audit log |

### 10.3 Try maintenance mode

1. Switch it on:

   ```bash
   curl -s -X PUT $API/admin/site-settings -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
     -d '{"maintenanceMode":true,"maintenanceMessage":"Back by 2pm."}'
   ```

2. Wait about 5 seconds (it is read every 5 s), then request a quote. Expected answer:

   ```json
   {"statusCode":503,"code":"MAINTENANCE","message":"Back by 2pm."}
   ```

3. `GET /v1/kyc` and logging in still work.
4. Switch it back off with `{"maintenanceMode":false}`.

---

## 11. Automated tests

| Command (from `api/`) | What it runs | Needs |
|---|---|---|
| `npm test` | all 1,084 unit tests (fakes; no server) | nothing running |
| `npx jest src/kyc` | one folder | nothing running |
| `npx jest -t "Basic"` | tests whose name matches | nothing running |
| `npm run test:e2e` | end-to-end tests over real HTTP against a running server | the server from section 1. For the admin tests, also `E2E_ADMIN_EMAIL` and `E2E_ADMIN_PASSWORD` set. |

Details of the end-to-end suite: [`test/e2e/README.md`](../test/e2e/README.md).
