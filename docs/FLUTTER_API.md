# DavoChain Mobile API: Flutter Integration Guide

| | |
| --- | --- |
| **For** | The Flutter developer building the DavoChain mobile app |
| **API version** | `v1` |
| **Last verified** | 2 October 2026, against the API source (`api/src/`) and a running local instance. Rate limiting (0.4.1, 2.x errors) added 12 October 2026. Basic verification (4.2, 4.4, §0.6) added 14 October 2026. Bug fixes and maintenance enforcement (Appendix F) 15 October 2026. |
| **Source of truth** | The API code. If this guide and the API disagree, tell the backend team so the guide gets fixed. |
| **Replaces** | `admin/docs/FLUTTER.md` |

## How to use this guide

1. Read **Part 0, Before you start** once. It covers the rules that apply to every call: base URL, headers, money format, errors, tokens.
2. Build each screen from **Part 1, Endpoints**. Every endpoint is written the same way:
   - **Endpoint:** method, path, whether a token is needed, the KYC level needed, and the success status
   - **What it does:** in plain words, and when to call it
   - **Request:** headers, path/query parameters, body fields with their rules, and a full example
   - **Response:** a full example, plus a table explaining every field
   - **Errors:** each error you can get, with the exact message
   - **Integration notes:** UX rules and gotchas
3. Use **Part 2, Appendices** for push notifications, enum values, ready-made Dart code, testing on the local backend, and known limitations.

## What changed for the app (21 October 2026): Payrep is the naira provider

DavoChain moved its naira deposits and payouts from Flutterwave to **Payrep MFB**. No request body changes; some values the app shows do.

| Change | Where | What the app must do |
| --- | --- | --- |
| **Deposit accounts are Payrep accounts:** `bankName` is `"Payrep MFB"`, and the account name starts with DavoChain's business name | 6.4, 6.5 | Show `bankName` and `accountName` exactly as sent. The account is still permanent and the same flow opens it. |
| **Bank codes in the bank list are 6-digit NIP codes** (Access Bank is `"000014"`, was `"044"`) | 8.5, 8.6, 8.8 | Always take `code` from 8.5. A bank account saved before 21 Oct with a 3-digit code answers `400 "Choose a supported Nigerian bank"` at withdrawal: ask the customer to save it again. |
| **`provider` in deposit history is `PAYREP`** for a bank transfer into the naira account | 6.3 | Treat `PAYREP` (and the older `FLUTTERWAVE`) as "bank transfer". |
| **A deposit into a switched-off account is held** | 6.4 | Nothing to send. It shows as `ON_HOLD` (push `deposit.on_hold`) until an admin reviews it. |

## What changed for the app (21 October 2026): Advanced verification

| Change | Where | What the app must do |
| --- | --- | --- |
| **Two new upload types:** `NATIONAL_ID` (front of the card) and `ID_BACK` (back of a national ID or driver's licence) | 4.3 | Use them for Advanced. `VOTERS_CARD` is still accepted as an upload but **not** for Advanced. |
| **Advanced step A: ID + selfie** | 4.6 | Upload the ID and a camera selfie, then `POST /v1/kyc/advanced/identity`. Answer is `202` "CHECKING"; poll `GET /v1/kyc`. |
| **Advanced step B: proof of address** | 4.6 | Upload ONE document of the customer's choice, then `POST /v1/kyc/advanced/address`. A tenancy agreement is **optional**: any one of the four kinds is enough. |
| **`GET /v1/kyc` has an `advanced` block, and `level` names all four levels** | 4.1 | `level` is now `NONE`, `BASIC`, `ADVANCED_IN_PROGRESS` or `ADVANCED` (before, Advanced customers read `BASIC`). Show `advanced.identity.reason` / `advanced.address.reason` as they are: they are written for customers. |

## What changed for the app (19 October 2026): naira payouts through the naira rail

| Change | Where | What the app must do |
| --- | --- | --- |
| **Naira withdrawals are paid by the naira rail** (Flutterwave then; Payrep since 21 Oct), not Quidax | 8.7 | Nothing in the request changes. |
| **The bank list (8.5) and account-name check (8.6, 8.8) come from the naira rail** | 8.5, 8.6, 8.8 | Always load banks from 8.5. A bank account saved before 19 Oct with a code the rail doesn't know answers `400 "Choose a supported Nigerian bank"` at withdrawal: ask the customer to save it again. |

## What changed for the app (16 October 2026): balance corrections

| Change | Where | What the app must do |
| --- | --- | --- |
| **Trade history can include a "Balance correction"** | 7.3 | Rows with `type: "ADJUSTMENT"` carry `label: "Balance correction"`. Show the label and the amount (in = `toAmount`, out = `fromAmount`). |

## What changed for the app (15 October 2026, later): saved withdrawal destinations

**Breaking.** Withdrawals now go **only** to a bank account or crypto address the customer has saved, with their password, beforehand. This closes the "stolen login sends everything away" gap (C6).

| Change | Where | What the app must do |
| --- | --- | --- |
| **New: saved bank accounts** `GET/POST/DELETE /v1/me/bank-accounts` | 8.8 | A "Bank accounts" screen: pick a bank (8.5), type the number, enter the password, save. Show the returned account name. |
| **New: saved crypto addresses** `GET/POST/DELETE /v1/me/crypto-addresses` | 8.9 | An "Addresses" screen: coin, network, address (+ tag), password, save. |
| **`POST /v1/withdrawals/ngn` body changed** | 8.7 | Send `{ amount, savedBankAccountId }`. The old `accountNumber`/`bankCode` body answers `400 "Choose a saved bank account"`. |
| **`POST /v1/withdrawals/crypto` body changed** | 8.2 | Send `{ amount, savedCryptoAddressId }`. The old body answers `400 "Choose a saved address"`. |
| **New `403`: `code: "DESTINATION_COOLING_OFF"`** | 8.8 | A newly saved destination may have a wait set by the admin (`usableFrom` on each saved item). Show `message`; disable it until `until`. |
| **8.6 Verify a bank account is optional now** | 8.6 | Saving (8.8) looks the name up itself and returns it. 8.6 still works while naira payouts are switched on. |

## What changed for the app (15 October 2026): verification levels

Admins now decide, on one screen, what people at each level may do: **None** (not verified), **Basic** and **Advanced**. Nothing is fixed in the app or the server any more.

| Change | Where | What the app must do |
| --- | --- | --- |
| **New: `GET /v1/me/level`** | 3.3 | Use it to show what the person may do, their limits and what is left today. Never hard-code a limit. |
| **New `403` body: `code: "NOT_ALLOWED_AT_LEVEL"`** | §0.6 | Not allowed at their level. If `requiredLevel` is set, open the verification screen; if it is `null`, show `message` (nobody may do it right now). `requiredTier` is still sent for older app builds. |
| **New `403` body: `code: "COOLING_OFF"`** | §0.6 | Withdrawals wait after sign-up and after a password change. Show `message`; `until` says when they open. |
| **Limits may be `null`** ("no limit") | 4.1, 8.4 | Show "No limit" instead of a number. A new `currency` field says whether the limit figures are naira or dollars. |
| **Gift-card selling has a daily limit** | 9.3 | A refusal is `400` with the reason in `message`. |

## What changed for the app (14 October 2026): Basic verification

| Change | Where | What the app must do |
| --- | --- | --- |
| **`POST /v1/kyc/tier1` is gone** (now `404`) | 4.2 | Use **`POST /v1/kyc/basic`**. It takes names, date of birth, address and state of origin as well as the BVN/NIN, and answers at once. |
| **New: `GET /v1/kyc/states`** | 4.4 | Load the state and LGA pickers from it |
| **`GET /v1/kyc` has new fields** | 4.1 | `level`, `basicState`, `underReview`, `attemptsLeftToday`, `attemptsLeftTotal` |
| **`phone` is required at sign-up** | 2.1 | Make the field mandatory. A phone already in use now gives `400` (it used to give `500`). |
| **Verification-gated endpoints have two new `403` answers** | §0.4, §0.6 | Handle `code: "VERIFICATION_PENDING"` and `code: "ACCOUNT_UNDER_REVIEW"` (Dart: D.3) |
| **The naira deposit account needs the person to be fully cleared** | 6.4, 6.5 | Show `reason` as sent; it can now say "under review" |
| **New rate limit:** Basic submissions, 5 per hour per user | §0.4.1 | Never auto-retry 4.2 |
| **Basic is switched off until launch** | Appendix F 3a | 4.2 answers `503 "Verification is not available yet."`; build the screens anyway |

---

## Contents

**Part 0: Before you start**
[0.1 Base URL](#01-base-url) · [0.2 Headers](#02-headers) · [0.3 Data formats](#03-data-formats) · [0.4 Errors](#04-errors) · [0.4.1 Rate limits](#041-rate-limits) · [0.5 Tokens and sessions](#05-tokens-and-sessions) · [0.6 KYC gate](#06-kyc-gate) · [0.7 Idempotency-Key](#07-idempotency-key) · [0.8 Transaction statuses](#08-transaction-statuses) · [0.9 Image URLs](#09-image-urls)

**Part 1: Endpoints**

| # | Area | Endpoints |
| --- | --- | --- |
| 1 | [Health](#1-health) | 1.1 Server health |
| 2 | [Authentication](#2-authentication) | 2.1 Register · 2.2 Log in · 2.3 Refresh token · 2.4 Log out · 2.5 Change password · 2.6 Request reset code · 2.7 Reset password · 2.8 Who am I (token) |
| 3 | [Profile & wallets](#3-profile--wallets) | 3.1 Get profile · 3.2 Get wallet balances |
| 4 | [KYC](#4-kyc-identity-verification) | 4.1 Get KYC status · 4.2 Basic verification · 4.3 Upload a document · 4.4 States and LGAs · 4.5 Basic screen flow · 4.6 Advanced verification |
| 5 | [Assets](#5-assets--networks) | 5.1 List coins · 5.2 List a coin's networks |
| 6 | [Deposits](#6-deposits) | 6.1 Get deposit address · 6.2 List my addresses · 6.3 Deposit history · 6.4 Naira account · 6.5 Open naira account |
| 7 | [Trading](#7-trading-buy-sell-swap) | 7.1 Get a quote · 7.2 Execute a quote · 7.3 Trade history · 7.4 Get one transaction |
| 8 | [Withdrawals](#8-withdrawals) | 8.1 Crypto fee quote · 8.2 Withdraw crypto · 8.3 Withdrawal history · 8.4 Naira fee quote · 8.5 Bank list · 8.6 Verify bank account · 8.7 Withdraw naira · 8.8 Saved bank accounts · 8.9 Saved crypto addresses |
| 9 | [Gift cards](#9-gift-cards) | 9.1 Catalogue · 9.2 Brand logo · 9.3 Sell a card · 9.4 My card trades · 9.5 One card trade · 9.6 Card photo |
| 10 | [Referrals](#10-referrals) | 10.1 Check a code · 10.2 Referral dashboard · 10.3 Set username |
| 11 | [Notifications](#11-notifications) | 11.1 Notification feed · 11.2 Mark as read |
| 12 | [Devices (push)](#12-devices-push-tokens) | 12.1 Register device · 12.2 Unregister device · 12.3 List devices |
| 13 | [Site & content](#13-site-settings--content) | 13.1 Site settings · 13.2 Logo · 13.3 Social icon · 13.4 List pages · 13.5 Get page · 13.6 FAQs |

**Part 2: Appendices**
[A. Push notifications](#appendix-a-push-notifications) · [B. Enum values](#appendix-b-enum-values) · [C. Screen flows](#appendix-c-screen-flows) · [D. Dart starter code](#appendix-d-dart-starter-code) · [E. Testing on the local backend](#appendix-e-testing-on-the-local-backend) · [F. Known limitations](#appendix-f-known-limitations--upcoming-changes) · [G. Endpoint index](#appendix-g-endpoint-index)

---

# Part 0: Before you start

## 0.1 Base URL

Every endpoint in this guide is written as a full path starting with `/v1/…`. Prefix it with the **host**:

| Environment | Host |
| --- | --- |
| Production | `https://<api-host>` (not decided yet; make it a build config value) |
| Android emulator → API on your laptop | `http://10.0.2.2:3000` |
| iOS simulator → API on your laptop | `http://localhost:3000` |
| Physical phone → API on your laptop | `http://<laptop LAN IP>:3000` (same Wi-Fi) |

Example: host `http://10.0.2.2:3000` + endpoint `/v1/auth/login` = `http://10.0.2.2:3000/v1/auth/login`.

Store the **host** in config, not a base URL that already ends in `/v1`. Some responses contain paths that already start with `/v1/…` (§0.9). The one endpoint without `/v1` is `GET /health`.

In development you can try every endpoint in the browser at `http://<host>/docs` (Swagger).

## 0.2 Headers

| Header | When | Value |
| --- | --- | --- |
| `Content-Type` | Every request that has a body | `application/json` |
| `Authorization` | Every endpoint marked **Auth: Bearer** | `Bearer <accessToken>` |
| `Idempotency-Key` | Only on 7.2, 8.2, 8.7 (money-moving) | A UUID v4 you generate (§0.7) |

## 0.3 Data formats

| Thing | Format | Example |
| --- | --- | --- |
| **Money / amounts** | **Always a string.** Parse it into `Decimal` (package `decimal`), **never `double`**. Send amounts as strings too. | `"97150.00"`, `"0.00067342"` |
| Amount strings you send | Plain decimal: no exponent, no commas | `"0.0015"` ✅ `"1.5e-3"` ❌ `"50,000"` ❌ |
| Amount precision you receive | Some are fixed (`"97150.00"`), some full precision (`"0.000673"`) | Always parse; format with the coin's `displayScale` |
| Dates | ISO-8601 UTC string | `"2026-10-02T10:25:10.100Z"` |
| IDs | UUID string | `"9b4e20f9-2f1c-4d3e-9a51-0c7d5e1b2a40"` |
| Asset codes | Lowercase | `ngn`, `btc`, `usdt` |
| Network ids | Exactly as returned by 5.1/5.2. **Some contain spaces**, e.g. TON is `"ton network"`. URL-encode them in query strings. | `bep20`, `trc20`, `ton network` |
| `limit` query param | Integer, max 100 | `?limit=50` |
| **Unknown body fields** | **Rejected with 400** ("property X should not exist"). Send only the documented fields, and don't send `null` for optional fields you aren't setting: leave them out. | |
| Body size | Max **1 MB** per request, except: selling a gift card (9.3) up to **36 MB**, and a KYC document file (4.3) up to **10 MB** | |

## 0.4 Errors

**Normal error body:**
```json
{ "statusCode": 400, "message": "Minimum BTC trade is $18.00. This one is worth $12.00.", "error": "Bad Request" }
```

`message` is **sometimes an array**, when several fields fail validation:
```json
{ "statusCode": 400, "message": ["property extra should not exist", "email must be an email"], "error": "Bad Request" }
```

**Special error bodies.** These have no `statusCode` field, so decide using the HTTP status:
```json
{ "code": "ACCOUNT_SUSPENDED", "message": "<reason written by an admin>", "suspendedAt": "2026-10-01T09:00:00.000Z" }
{ "code": "ACCOUNT_CLOSED", "message": "This account is closed. Contact support." }
{ "message": "Verification required before you can do this", "requiredTier": "TIER_1", "currentTier": "TIER_0", "kycStatus": "NOT_STARTED" }
{ "code": "VERIFICATION_PENDING", "message": "Your verification is still being completed." }
{ "code": "ACCOUNT_UNDER_REVIEW", "message": "Your account is under review. Contact support." }
{ "statusCode": 503, "code": "MAINTENANCE", "message": "<the admin's maintenance message>" }
```

**Rules:**
- Show `message` to the user **as-is**. It's written for people, and it often tells them whether money moved ("…Nothing was deducted from your balance.").
- **Never write logic based on message text.** Wording can change. Use the status code, plus `code` / `requiredTier` when present.

| Status | Meaning | What the app does |
| --- | --- | --- |
| 400 | Request rejected. **Nothing moved.** | Show `message` |
| 401 | Token missing, expired or invalid ("Missing bearer token" / "Invalid or expired token") | Refresh the token once and retry (§0.5), **except** on the auth routes listed in §0.5 |
| 403 | Not allowed: KYC too low, account suspended or closed, feature paused or off | If the body has `requiredTier`, open the verification screen. If `code`, the blocked-account screen. Otherwise show `message`. |
| 404 | Not found, or not yours (the API doesn't tell you which) | Show `message` |
| 409 | Conflict (see each endpoint) | See each endpoint |
| 413 | Request body too large (1 MB normally; 36 MB for 9.3; a 10 MB file for 4.3) | Show `message`; make the photo or file smaller |
| 503 | `"File storage is unavailable right now. Please try again shortly."` (uploads and photos) | Show `message`; let the user try again |
| 429 | Too many requests (rate limit, §0.4.1). Body `{ "statusCode": 429, "message": "Too many attempts. Try again in N seconds." }` and a `Retry-After: N` header | Show `message`. Disable the button for `Retry-After` seconds. **Never** retry automatically on the auth routes. |
| 503 with `code: "MAINTENANCE"` | Maintenance mode is on (quotes, trades, withdrawals, deposit addresses, the naira account, gift-card trades, Basic) | Show the full-screen maintenance page with `message`. Sign-in, balances and history still work. |
| 500 / 503 | Server or provider problem. On the auth routes a `503` can also mean the sign-in protection is briefly unavailable (`"Temporarily unavailable. Try again shortly."`) or the server is busy (`"The service is busy, try again shortly"`) | "Something went wrong, please try again." **Never** auto-retry money actions without the same Idempotency-Key. |

### 0.4.1 Rate limits

Every endpoint has a request limit. Going over it returns **`429`** with a `Retry-After` header (seconds). The limits below are the defaults. The backend can change them without an app release, so **never hard-code them**: always use `Retry-After`.

| Endpoint | Limit (default) | Counted per |
| --- | --- | --- |
| 2.2 Log in | 20 per 15 min · 10 per 15 min | IP address · email address |
| 2.1 Register | 5 per hour | IP address |
| 2.6 Request reset code | 10 per hour · 3 per hour | IP address · email address |
| 2.7 Reset password | 20 per hour | IP address |
| 2.3 Refresh token | 60 per minute | IP address |
| 2.5 Change password | 5 per hour | Signed-in user |
| 4.2 Basic verification | 5 per hour | Signed-in user |
| Public endpoints (1.1, 5.1, 5.2, 9.1, 9.2, 10.1, 13.x) | 120 per minute | IP address |
| Everything else | 300 per minute | Signed-in user |

**What this means for the app**
- **The `429` message is the same whichever limit was hit.** It never says whether an email exists. Show it as-is.
- **Never auto-retry 2.1, 2.2, 2.3, 2.5, 2.6 or 2.7 on `429`.** Each retry counts again. Show the message, and enable the button again after `Retry-After` seconds.
- **Limits per IP are shared** by everyone behind the same IP (an office Wi-Fi, some mobile networks). A user can see `429` without having done much themselves. The message tells them how long to wait.
- **Refresh (2.3) on `429`:** the session is **not** expired. Wait `Retry-After` seconds and refresh again. Don't sign the user out.
- **A `503` on the auth routes is temporary.** Show the message and let the user try again. It is not a wrong password, and it does **not** count toward the 5-failure lock.
- **The account lock (2.2) is separate from rate limits:** 5 wrong passwords in a row lock the account for 15 minutes (`403`, with the unlock time). While locked, even the right password gets the `403`. A password reset (2.6 / 2.7) clears it; otherwise it lifts at the time shown.

## 0.5 Tokens and sessions

**Two tokens** come back from register, login and refresh:

| Token | Lifetime | Use |
| --- | --- | --- |
| `accessToken` (JWT) | **15 minutes** | Header `Authorization: Bearer <accessToken>` |
| `refreshToken` (random string) | **30 days, single use** | Body of 2.3 (refresh) and 2.4 (logout) |

Store both in **`flutter_secure_storage`**. Never use `SharedPreferences`.

**Refreshing: ONE refresh at a time.** Each refresh returns a **new** refresh token and kills the old one. If two refreshes run at once with the same token, the server thinks it was stolen and **signs the user out everywhere**. So:

1. A request gets `401`.
2. If a refresh is already running, **wait for that one**. Otherwise start it (call 2.3).
3. Success: save **both** new tokens, retry the original request **once**.
4. Refresh also fails with `401`: clear tokens, go to the sign-in screen.

(Ready-made Dart interceptor in Appendix D.)

**Don't auto-refresh on these routes.** A 401 or 400 there means wrong credentials, not an expired token: 2.1 register, 2.2 login, 2.3 refresh, 2.5 change password, 2.6 / 2.7 reset.

**When the server ends the user's session** (the app must handle all of these):

| Event | What happens | What the app does |
| --- | --- | --- |
| Admin **approves or rejects KYC** | All refresh tokens revoked. The access token still works (with the *old* verification level) for up to 15 min. | When 4.1 shows `APPROVED`, show "You're verified, please sign in again", then clear tokens and go to sign-in |
| User **changes password** (2.5) | All refresh tokens revoked, **including this phone's** | After success, clear tokens and go to sign-in |
| User **resets password** (2.7) | All refresh tokens revoked | Go to sign-in |
| Admin **suspends** the user | Refresh tokens revoked; login returns `ACCOUNT_SUSPENDED` | Show the blocked screen with `message` |
| Refresh token older than 30 days, or reused | Refresh returns 401 | Sign-in |

**Password rules** (check them in the app before sending): **10–128 characters, at least one letter and at least one number.**

## 0.6 KYC gate

Some endpoints need the user to be **verified: TIER_1 with status APPROVED**. In this guide they're marked **KYC: TIER_1**:

7.1 quote · 7.2 execute trade · 6.1 deposit address · 8.2 withdraw crypto · 8.6 verify bank account · 8.7 withdraw naira

The server checks the user's **current** verification on every one of these requests (not the copy inside the token), and also their compliance standing. Three `403` answers:

| Body | Meaning | What the app does |
| --- | --- | --- |
| `requiredTier`, `currentTier`, `kycStatus` | Not verified (yet) | Open the verification screen (4.2) |
| `code: "VERIFICATION_PENDING"` | Basic was submitted and is still being completed | Show `message`; re-check 4.1 later |
| `code: "ACCOUNT_UNDER_REVIEW"` | The account is under review | Show `message` **exactly as sent**. Don't guess or explain why; the API never says. |

Right after approval the user's sessions are signed out on purpose, so the app's own copy of the tier catches up when they **sign in again** (§0.5).

**Since 15 Oct 2026 the gate is the admin's level rules** (3.3), not a fixed tier. Two more `403` answers:

| Body | Meaning | What the app does |
| --- | --- | --- |
| `code: "NOT_ALLOWED_AT_LEVEL"`, `action`, `currentLevel`, `requiredLevel`, `requiredTier` | Their level may not do this | `requiredLevel` set: open the verification screen (4.2). `requiredLevel: null`: nobody may do it right now; show `message`. |
| `code: "COOLING_OFF"`, `action`, `until` | A new account, or a password just changed: withdrawals wait | Show `message` (it says when, in Lagos time); `until` is the ISO time they open |

```json
{ "code": "NOT_ALLOWED_AT_LEVEL", "action": "GIFTCARD_SELL", "currentLevel": "NONE", "requiredLevel": "BASIC", "requiredTier": "TIER_1", "message": "Complete Basic verification to sell gift cards." }
{ "code": "COOLING_OFF", "action": "CRYPTO_WITHDRAW", "until": "2026-10-16T00:00:00.000Z", "message": "Withdrawals open at 01:00 on 16 October, 24 hours after sign-up." }
```

`requiredTier` is still sent with `NOT_ALLOWED_AT_LEVEL` so older app builds keep opening the verification screen.

## 0.7 Idempotency-Key

Endpoints that move money (7.2, 8.2, 8.7) **require** the header `Idempotency-Key: <uuid v4>`. It stops a retry from charging the user twice.

- Create a **new UUID when the user taps Confirm**.
- If the request times out or the connection drops, **retry with the SAME key**. The server returns the original result instead of doing it again.
- A **new tap** gets a **new key**.

| You get | Meaning | Do |
| --- | --- | --- |
| The normal `201` body | Either the first run or a replay of a finished one | Use it |
| `409` "This request is still processing" | The first attempt is still running | Wait 2–3 s, retry with the **same** key |
| `409` "This Idempotency-Key was already used with a different request" | Same key, different body: an app bug | Make a new key |
| `400` "Idempotency-Key header is required for this request" | Header missing | App bug |

## 0.8 Transaction statuses

What to show for each status on trades, withdrawals and deposits:

| Status | Meaning | Show the user |
| --- | --- | --- |
| `PENDING` | Accepted, funds held, not finished | "Processing…" |
| `PROCESSING` | Being completed by the provider (swaps, withdrawals) | "Processing…", and poll |
| `ON_HOLD` | Naira deposit waiting for review | "Under review" + `reason` |
| `COMPLETED` | Done, success | Success |
| `FAILED` | Done, failed. The money is back in the balance. | `reason` |
| `RECONCILING` | **Result unknown for now.** Money is held safely while the backend checks with the provider. | "We're confirming this with our provider. Your funds are safe." **No retry button. Never say "failed".** |

## 0.9 Image URLs

| Where | URL type | How to load |
| --- | --- | --- |
| 13.1 `logoUrl` | **Relative**, e.g. `/v1/site/logo?v=…` | host + path. No token. |
| 13.1 `socials[].iconUrl` | Absolute | As is. No token. |
| 9.1 `brands[].imageUrl` | Absolute | As is. No token. Cache forever. |
| 9.4 `images[]` | **Relative**, e.g. `/v1/giftcards/trades/{id}/images/{imageId}` | host + path, **with** `Authorization` header |

---

# Part 1: Endpoints

## 1. Health

### 1.1 Server health

**Endpoint:** `GET /health` (no `/v1`) · **Auth:** none · **KYC:** none · **Success:** `200`

**What it does**
Tells you whether the API is up and can reach its database. Use it only for a "can't reach server" check (e.g. a no-connection banner). Never show its fields to users.

**Request**
No headers, no body.
```http
GET /health
```

**Response** `200`
```json
{ "status": "ok", "database": "up", "time": "2026-10-02T10:25:10.100Z" }
```

| Field | Type | Description |
| --- | --- | --- |
| `status` | string | `ok` or `degraded` |
| `database` | string | `up` or `down` |
| `time` | string (date) | Server time |

---

## 2. Authentication

### 2.1 Register

**Endpoint:** `POST /v1/auth/register` · **Auth:** none · **KYC:** none · **Success:** `201`

**What it does**
Creates a new user account **and signs them in** (returns tokens, so there's no separate login call). Can attach a referral code. In the background it also sets up the user's crypto wallet and sends a welcome email.

**Request**

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |

| Field | Type | Required | Rules | Example |
| --- | --- | --- | --- | --- |
| `email` | string | ✅ | Valid email, max 254 chars. Saved in lowercase. | `"ada@example.com"` |
| `password` | string | ✅ | 10–128 chars, ≥ 1 letter, ≥ 1 number | `"correcthorse42"` |
| `firstName` | string | ✅ | 1–60 chars | `"Ada"` |
| `lastName` | string | ✅ | 1–60 chars | `"Obi"` |
| `phone` | string | ✅ | `+` optional, then 7–15 digits. Must not belong to another account. Required since Basic verification; not yet confirmed by SMS. | `"+2348012345678"` |
| `referralCode` | string | ❌ | Max 16 chars. An invalid code is **ignored**; it never blocks signup. | `"ADA4K9"` |

```http
POST /v1/auth/register
Content-Type: application/json

{
  "email": "ada@example.com",
  "password": "correcthorse42",
  "firstName": "Ada",
  "lastName": "Obi",
  "phone": "+2348012345678",
  "referralCode": "ADA4K9"
}
```

**Response** `201`
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOi…",
  "refreshToken": "q3V9bWx0Z3Z…",
  "expiresIn": "15m",
  "userId": "9b4e20f9-2f1c-4d3e-9a51-0c7d5e1b2a40"
}
```

| Field | Type | Description |
| --- | --- | --- |
| `accessToken` | string | Send as `Authorization: Bearer …` |
| `refreshToken` | string | Keep it secret; use it for 2.3 and 2.4 |
| `expiresIn` | string | Access token lifetime, `"15m"` |
| `userId` | string (UUID) | The new user's id |

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 400 | Email or phone number already registered (the API doesn't say which) | `"Unable to register with those details"` |
| 400 | Invalid field, or `phone` missing | Array, e.g. `["Enter a valid email address", "Password must be at least 10 characters", "Password must contain a number", "Enter a valid phone number"]` |
| 429 | More than 5 sign-ups from this IP in an hour (§0.4.1) | `"Too many attempts. Try again in N seconds."` + `Retry-After` |
| 503 | Sign-up protection briefly unavailable, or the server is busy | `"Temporarily unavailable. Try again shortly."` / `"The service is busy, try again shortly"` |

**Integration notes**
- Save both tokens, then call **12.1** to register the phone for push.
- The new user is **not verified** (`TIER_0`). Send them to the KYC flow (section 4) before trading.
- Use **10.1** first if the user typed or opened a referral code, to show "Invited by Ada".

---

### 2.2 Log in

**Endpoint:** `POST /v1/auth/login` · **Auth:** none · **KYC:** none · **Success:** `200`

**What it does**
Signs an existing user in and returns a new pair of tokens. After 5 wrong passwords in a row the account is locked for 15 minutes.

**Request**

| Field | Type | Required | Rules | Example |
| --- | --- | --- | --- | --- |
| `email` | string | ✅ | Valid email, max 254 | `"ada@example.com"` |
| `password` | string | ✅ | Max 128 | `"correcthorse42"` |

```http
POST /v1/auth/login
Content-Type: application/json

{ "email": "ada@example.com", "password": "correcthorse42" }
```

**Response** `200`
```json
{ "accessToken": "eyJhbGciOi…", "refreshToken": "q3V9bWx0…", "expiresIn": "15m" }
```

| Field | Type | Description |
| --- | --- | --- |
| `accessToken` | string | Bearer token, valid 15 min |
| `refreshToken` | string | Single-use refresh token, valid 30 days |
| `expiresIn` | string | `"15m"` |

**Errors**

| Status | When | Body / `message` |
| --- | --- | --- |
| 401 | Wrong email or password | `"Incorrect email or password"` |
| 403 | Locked after 5 failures | `"Too many failed attempts. Try again after 2026-10-02T10:40:00.000Z"` |
| 403 | Account suspended | `{ "code": "ACCOUNT_SUSPENDED", "message": "<admin's reason>", "suspendedAt": "…" }` |
| 403 | Account closed | `{ "code": "ACCOUNT_CLOSED", "message": "This account is closed. Contact support." }` |
| 400 | Bad email format | `["email must be an email"]` |
| 429 | Too many sign-in attempts for this email (10 per 15 min) or from this IP (20 per 15 min) (§0.4.1) | `"Too many attempts. Try again in N seconds."` + `Retry-After` |
| 503 | Sign-in protection briefly unavailable, or the server is busy. **Not** counted as a wrong password. | `"Temporarily unavailable. Try again shortly."` / `"The service is busy, try again shortly"` |

**Integration notes**
- `429` and the `403` lock are different. `429` is a rate limit: wait `Retry-After` seconds. `403` "Too many failed attempts" is the account lock: wait until the time in the message, or reset the password.
- Show `ACCOUNT_SUSPENDED` / `ACCOUNT_CLOSED` on a dedicated screen with `message` verbatim.
- After login, call **12.1** (register device) and **3.1** (profile).

---

### 2.3 Refresh token

**Endpoint:** `POST /v1/auth/refresh` · **Auth:** none · **KYC:** none · **Success:** `200`

**What it does**
Swaps a refresh token for a **new access token and a new refresh token**. The old refresh token stops working immediately.

**Request**

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `refreshToken` | string | ✅ | Max 512 |

```http
POST /v1/auth/refresh
Content-Type: application/json

{ "refreshToken": "q3V9bWx0…" }
```

**Response** `200`: same shape as 2.2.
```json
{ "accessToken": "eyJhbGciOi…", "refreshToken": "N7pQ…", "expiresIn": "15m" }
```

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 401 | Token unknown | `"Invalid refresh token"` |
| 401 | Token expired, already used, or revoked (password change, KYC decision, suspension) | `"Session expired. Please sign in again."` |
| 429 | More than 60 refreshes a minute from this IP (§0.4.1). **The session is still valid.** | `"Too many attempts. Try again in N seconds."` + `Retry-After`. Wait, then refresh again; don't sign out. |
| 503 | Briefly unavailable | `"Temporarily unavailable. Try again shortly."` Retry shortly; don't sign out. |

**Integration notes**
- **Save the new refresh token.** The old one is dead.
- **Only one refresh at a time** (§0.5). Use the interceptor in Appendix D.
- If this returns 401, clear tokens and go to sign-in.

---

### 2.4 Log out

**Endpoint:** `POST /v1/auth/logout` · **Auth:** **Bearer** · **KYC:** none · **Success:** `204`

**What it does**
Kills the given refresh token so it can't be used again.

**Request**

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <accessToken>` |

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `refreshToken` | string | ✅ | Max 512 |

```http
POST /v1/auth/logout
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json

{ "refreshToken": "q3V9bWx0…" }
```

**Response** `204`: no body.

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 401 | Access token missing or expired | `"Missing bearer token"` / `"Invalid or expired token"` |

**Integration notes**
- Order on sign-out: **12.2 unregister device**, then **2.4 logout**, then clear secure storage.
- If the access token has already expired, it's fine to skip this call and just clear local storage.

---

### 2.5 Change password

**Endpoint:** `POST /v1/auth/change-password` · **Auth:** **Bearer** · **KYC:** none · **Success:** `204`

**What it does**
Changes the password of a signed-in user. **It signs the user out of every device, including this one.** The user also gets a security email.

**Request**

| Field | Type | Required | Rules | Example |
| --- | --- | --- | --- | --- |
| `currentPassword` | string | ✅ | Max 128 | `"correcthorse42"` |
| `newPassword` | string | ✅ | 10–128, ≥ 1 letter, ≥ 1 number | `"newbattery77x"` |

```http
POST /v1/auth/change-password
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json

{ "currentPassword": "correcthorse42", "newPassword": "newbattery77x" }
```

**Response** `204`: no body.

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 401 | Current password wrong | `"Current password is incorrect"`. **Don't** treat this as an expired token. |
| 400 | New password breaks the rules | e.g. `["Password must be at least 10 characters"]` |
| 429 | More than 5 attempts in an hour (§0.4.1) | `"Too many attempts. Try again in N seconds."` + `Retry-After` |
| 503 | Briefly unavailable, or the server is busy | `"Temporarily unavailable. Try again shortly."` / `"The service is busy, try again shortly"` |

**Integration notes**
- **Exclude this route from the auto-refresh interceptor**, or a wrong current password will log the user out.
- After `204`: show "Password changed. Please sign in again", clear tokens, and open sign-in with the email pre-filled.

---

### 2.6 Request password-reset code

**Endpoint:** `POST /v1/auth/reset/request` · **Auth:** none · **KYC:** none · **Success:** `200`

**What it does**
Emails a 6-digit code to the user (valid **10 minutes**). For privacy it **always returns the same answer**, whether or not the email exists.

**Request**

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `email` | string | ✅ | Valid email, max 254 |

```http
POST /v1/auth/reset/request
Content-Type: application/json

{ "email": "ada@example.com" }
```

**Response** `200` (always)
```json
{ "message": "If that email belongs to an account, a six-digit code is on its way to it." }
```

| Field | Type | Description |
| --- | --- | --- |
| `message` | string | Show this to the user |

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 400 | Bad email format | `["Enter a valid email address"]` |
| 429 | More than 3 code requests for this email, or 10 from this IP, in an hour (§0.4.1) | `"Too many attempts. Try again in N seconds."` + `Retry-After` |
| 503 | Briefly unavailable | `"Temporarily unavailable. Try again shortly."` |

**Integration notes**
- Always move on to the "enter code" step, even for unknown emails.
- "Resend code" should wait **60 s**. Faster requests are silently ignored, so no new code is sent.

---

### 2.7 Reset password with code

**Endpoint:** `POST /v1/auth/reset/confirm` · **Auth:** none · **KYC:** none · **Success:** `204`

**What it does**
Checks the emailed code and sets a new password. Signs the user out everywhere and unlocks a locked account. **It doesn't sign the user in.**

**Request**

| Field | Type | Required | Rules | Example |
| --- | --- | --- | --- | --- |
| `email` | string | ✅ | Valid email | `"ada@example.com"` |
| `code` | string | ✅ | Exactly 6 digits | `"482913"` |
| `newPassword` | string | ✅ | 10–128, ≥ 1 letter, ≥ 1 number | `"newbattery77x"` |

```http
POST /v1/auth/reset/confirm
Content-Type: application/json

{ "email": "ada@example.com", "code": "482913", "newPassword": "newbattery77x" }
```

**Response** `204`: no body.

**Errors** (`400` unless stated)

| When | `message` |
| --- | --- |
| `429`: more than 20 attempts from this IP in an hour (§0.4.1) | `"Too many attempts. Try again in N seconds."` + `Retry-After` |
| `503`: briefly unavailable, or the server is busy | `"Temporarily unavailable. Try again shortly."` / `"The service is busy, try again shortly"` |
| Wrong code | `"That code is not right."` or `"That code is not right. 3 tries left."` |
| Code older than 10 min | `"That code has expired. Ask for a new one."` |
| 5 wrong attempts | `"Too many wrong codes. Ask for a new one."` |
| Same as the old password | `"That is the password you already had. Choose a different one."` |
| Code not 6 digits | `["The code is six digits"]` |

**Integration notes**
- Show the "tries left" message verbatim.
- After `204`, go to sign-in with the email pre-filled.

---

### 2.8 Who am I (from token)

**Endpoint:** `GET /v1/auth/me` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Returns what's inside the current access token. It doesn't read the database, so it can be up to 15 minutes out of date. For screens, use **3.1** instead.

**Request**
```http
GET /v1/auth/me
Authorization: Bearer eyJhbGciOi…
```

**Response** `200`
```json
{ "id": "9b4e20f9-2f1c-4d3e-9a51-0c7d5e1b2a40", "email": "ada@example.com", "kycTier": "TIER_0", "kycStatus": "NOT_STARTED" }
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | User id |
| `email` | string | User email |
| `kycTier` | string | `TIER_0`…`TIER_3`, as of when the token was issued |
| `kycStatus` | string | `NOT_STARTED` / `PENDING` / `APPROVED` / `REJECTED` / `EXPIRED`, as of token issue |

---

## 3. Profile & wallets

### 3.1 Get profile

**Endpoint:** `GET /v1/me` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Returns the signed-in user's profile, their current verification state (live from the database), and whether their crypto wallet is ready.

**Request**
```http
GET /v1/me
Authorization: Bearer eyJhbGciOi…
```

**Response** `200`
```json
{
  "id": "9b4e20f9-2f1c-4d3e-9a51-0c7d5e1b2a40",
  "email": "ada@example.com",
  "firstName": "Ada",
  "lastName": "Obi",
  "phone": "+2348012345678",
  "status": "ACTIVE",
  "kyc": {
    "tier": "TIER_1",
    "status": "APPROVED",
    "rejectionReason": null,
    "submittedAt": "2026-10-01T08:00:00.000Z"
  },
  "walletReady": true,
  "createdAt": "2026-09-30T12:00:00.000Z"
}
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | User id |
| `email` | string | |
| `firstName`, `lastName` | string | |
| `phone` | string \| null | |
| `status` | string | `ACTIVE` / `SUSPENDED` / `CLOSED` |
| `kyc.tier` | string | Current verification level |
| `kyc.status` | string | Current verification status |
| `kyc.rejectionReason` | string \| null | Why KYC was rejected (show it) |
| `kyc.submittedAt` | string \| null | When KYC was last submitted |
| `walletReady` | boolean | `false` while the crypto wallet is still being set up (usually seconds after signup) |
| `createdAt` | string | Signup date |

**Integration notes**
- Call this on app start and after login.
- `walletReady: false` means: show "Setting up your wallet…" on crypto screens. Nothing is blocked; 6.1 finishes the setup itself if needed.

---

### 3.2 Get wallet balances

**Endpoint:** `GET /v1/wallets` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Returns the user's balance for **every listed asset**: naira first, then each coin in display order. Zero balances are included.

**Request**
```http
GET /v1/wallets
Authorization: Bearer eyJhbGciOi…
```

**Response** `200`
```json
[
  { "asset": "ngn",  "name": "Nigerian Naira", "isFiat": true,  "available": "250000.00",  "locked": "0.00",       "total": "250000.00" },
  { "asset": "btc",  "name": "Bitcoin",        "isFiat": false, "available": "0.00067342", "locked": "0.00000000", "total": "0.00067342" },
  { "asset": "usdt", "name": "Tether",         "isFiat": false, "available": "0.000000",   "locked": "0.000000",   "total": "0.000000" }
]
```

| Field | Type | Description |
| --- | --- | --- |
| `asset` | string | Asset code |
| `name` | string | Display name |
| `isFiat` | boolean | `true` only for `ngn` |
| `available` | string | Spendable now |
| `locked` | string | Held by an in-progress trade or withdrawal |
| `total` | string | `available + locked` |

**Integration notes**
- Amounts are already cut (rounded down) to the asset's display decimals. Show them as they are.
- Show `available` as the spendable balance, and `locked` as "in progress".
- Refresh after any trade, withdrawal or deposit notification.

---

### 3.3 My verification level

**Endpoint:** `GET /v1/me/level` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does:** what this person may do at their level, the limits an admin set, and what is left today. Every number comes from the admin screen, so the app never hard-codes one.

**Response**

```json
{
  "level": "BASIC",
  "levelName": "Basic",
  "tier": "TIER_1",
  "advancedInProgress": false,
  "actions": [
    { "action": "BUY", "label": "buy crypto", "allowed": true, "currency": "USD", "minPerTx": null, "maxPerTx": null, "maxPerDay": "5000.00", "usedToday": "120.00", "remainingToday": "4880.00" },
    { "action": "GIFTCARD_SELL", "label": "sell gift cards", "allowed": true, "currency": "NGN", "minPerTx": null, "maxPerTx": null, "maxPerDay": null, "usedToday": "0.00", "remainingToday": null }
  ],
  "cooloffs": { "withdrawalsOpenAt": null }
}
```

- `level`: `NONE`, `BASIC` or `ADVANCED`. `levelName` is how to show it ("Advanced (in progress)" uses Basic's rules).
- `actions`: one row for each of `BUY`, `SELL`, `SWAP`, `CRYPTO_DEPOSIT`, `CRYPTO_WITHDRAW`, `NGN_DEPOSIT`, `NGN_WITHDRAW`, `GIFTCARD_SELL`. `null` = no limit. Amounts are in `currency`.
- `cooloffs.withdrawalsOpenAt`: when withdrawals open (ISO), or `null` if they are open now.
- Answers `503` while prices are unavailable (a dollar limit cannot be worked out without them).

## 4. KYC (identity verification)

**Basic** (`TIER_1`) = BVN **or** NIN, names, date of birth and address, **checked automatically**: the number is looked up, the names and date of birth must match the record, and the person is screened. A clear pass is Basic at once; anything else goes to a person, and the app is only told "under review". Advanced (Tier 2/3) isn't available yet.

### 4.1 Get KYC status

**Endpoint:** `GET /v1/kyc` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Returns the user's verification level and status, any rejection reason, and their **naira limits**: what they can deposit and withdraw today, plus what each tier allows.

**Request**
```http
GET /v1/kyc
Authorization: Bearer eyJhbGciOi…
```

**Response** `200`
```json
{
  "tier": "TIER_0",
  "status": "PENDING",
  "rejectionReason": null,
  "submittedAt": "2026-10-02T09:00:00.000Z",
  "bvnLast4": "5678",
  "documents": [],
  "level": "NONE",
  "basicState": "COMPLIANCE_REVIEW",
  "underReview": true,
  "attemptsLeftToday": 2,
  "attemptsLeftTotal": 9,
  "advanced": {
    "identity": { "state": "NONE", "reason": null, "attemptsLeft": { "today": 3, "total": 10 } },
    "address":  { "state": "NONE", "reason": null, "attemptsLeft": { "today": 3, "total": 10 } },
    "recencyMonths": 3
  },
  "limits": {
    "current": {
      "deposit":  { "singleNgn": "0.00", "dailyNgn": "0.00", "usedTodayNgn": "0.00", "remainingTodayNgn": "0.00" },
      "withdraw": { "singleNgn": "0.00", "dailyNgn": "0.00", "usedTodayNgn": "0.00", "remainingTodayNgn": "0.00" }
    },
    "tiers": [
      { "tier": "TIER_0", "depositSingleNgn": "0",      "depositDailyNgn": "0",      "withdrawSingleNgn": "0",      "withdrawDailyNgn": "0" },
      { "tier": "TIER_1", "depositSingleNgn": "200000", "depositDailyNgn": "500000", "withdrawSingleNgn": "200000", "withdrawDailyNgn": "500000" }
    ]
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `tier` | string | Current level, `TIER_0`…`TIER_3` |
| `status` | string | `NOT_STARTED` / `PENDING` / `APPROVED` / `REJECTED` / `EXPIRED` |
| `rejectionReason` | string \| null | Show when `REJECTED` |
| `submittedAt` | string \| null | Last submission |
| `bvnLast4` | string \| null | Last 4 BVN digits (for "BVN ending 5678") |
| `documents[]` | array | `{ "type": "PASSPORT", "status": "PENDING", "uploadedAt": "…" }`. Empty for now. |
| `level` | string | `NONE`, `BASIC`, `ADVANCED_IN_PROGRESS` (ID and selfie done, address not yet) or `ADVANCED` |
| `basicState` | string \| null | The latest Basic submission: `CREATED`, `LOOKED_UP`, `APPROVED`, `IDENTITY_REVIEW`, `COMPLIANCE_REVIEW`, `REJECTED_NOT_FOUND`, `REJECTED_BY_REVIEW`, `FAILED_SYSTEM`. `null` if never submitted. |
| `underReview` | boolean | `true` while a person is reviewing. Never says why. |
| `attemptsLeftToday` / `attemptsLeftTotal` | number | Basic submissions left (3 a day, 10 in all, by default). A "temporarily unavailable" failure doesn't use one. |
| `advanced.identity` / `advanced.address` | object | Each Advanced step: `state` is `NONE`, `CHECKING`, `IN_REVIEW`, `APPROVED`, `REJECTED` or `FAILED` (our side failed: no attempt used). `reason` is a customer-ready sentence when `IN_REVIEW`, `REJECTED` or `FAILED`, otherwise `null`. `attemptsLeft` counts per step (3 a day, 10 in all, by default). See 4.6. |
| `advanced.recencyMonths` | number | How recent a proof-of-address document must be (3 by default). Show it on the address screen. |
| `limits.current.deposit` / `.withdraw` | object | **This user, today** (resets at midnight Lagos time) |
| `…singleNgn` | string | Max per transaction |
| `…dailyNgn` | string | Max per day |
| `…usedTodayNgn` | string | Already used today |
| `…remainingTodayNgn` | string | Left today |
| `limits.tiers[]` | array | What each tier allows, for "verify to unlock more" screens. Values aren't padded to 2 decimals. |

**Integration notes**
- Limits apply to **naira only**.
- The numbers in `tiers` are set by admins and are all `0` on a fresh install.
- Show the right screen for each `status`:
  - `NOT_STARTED`: show the form (4.2).
  - `PENDING`: "We're reviewing your details". Re-check when the screen opens. Don't show the form while `underReview` is `true` (a second submission is refused with `409`).
  - `REJECTED`: show `rejectionReason` and the form again, if `attemptsLeftToday` > 0.
  - `APPROVED` with a token that still says unverified: ask the user to sign in again (§0.5).

---

### 4.2 Basic verification (BVN or NIN)

**Endpoint:** `POST /v1/kyc/basic` · **Auth:** **Bearer** · **KYC:** none · **Success:** `201`

**What it does**
Checks the user's BVN **or** NIN with the verification provider, compares the names and date of birth they typed with the record, and screens them. It answers in about 2–5 seconds:
- **clear pass:** the user is **Basic** at once. Their sessions are signed out on purpose so the new tier takes effect; they sign in again (§0.5);
- **anything that needs a person:** "under review". The user is emailed when it's decided;
- **number not found:** rejected, and the user may try again (it uses an attempt).

The BVN/NIN is **never stored** in readable form (only a keyed hash and the last 4 digits). The phone number is **not** compared with the BVN record.

**Request**

| Field | Type | Required | Rules | Example |
| --- | --- | --- | --- | --- |
| `idType` | string | ✅ | `BVN` or `NIN` | `"BVN"` |
| `idNumber` | string | ✅ | Exactly 11 digits | `"22222222222"` |
| `firstName` | string | ✅ | As on the ID. Letters, accents, `'`, `-`, `.`, spaces; max 60 | `"Adébáyọ̀"` |
| `middleName` | string | ❌ | Same rules. Compared only when the record has one too | `"Oluwaseun"` |
| `lastName` | string | ✅ | Same rules | `"Okafor"` |
| `dateOfBirth` | string | ✅ | `YYYY-MM-DD` | `"1994-05-20"` |
| `address.street` | string | ✅ | Max 200 | `"12 Marina Road"` |
| `address.city` | string | ✅ | Max 80 | `"Ikeja"` |
| `address.state` | string | ✅ | A state name from 4.4 | `"Lagos"` |
| `address.lga` | string | ✅ | An LGA of that state, from 4.4 | `"Ikeja"` |
| `address.postcode` | string | ❌ | 6 digits | `"100001"` |
| `stateOfOrigin` | string | ✅ | A state name from 4.4 | `"Ogun"` |
| `country` | string | ✅ | `NG` (the only value for now) | `"NG"` |

**Names match "exactly after cleanup":** accents, case, spaces, apostrophes and hyphens are ignored, and first and last name may be swapped. Anything else (a nickname, a missing letter) goes to a person, not to rejection.

```http
POST /v1/kyc/basic
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json

{
  "idType": "BVN", "idNumber": "22222222222",
  "firstName": "John", "middleName": "Doe", "lastName": "Ajayi", "dateOfBirth": "2000-05-01",
  "address": { "street": "12 Marina Road", "city": "Ikeja", "state": "Lagos", "lga": "Ikeja" },
  "stateOfOrigin": "Ogun", "country": "NG"
}
```

**Response** `201`
```json
{ "state": "APPROVED", "level": "BASIC", "message": "You are verified." }
```

| `state` | `level` | `message` | What the app does |
| --- | --- | --- | --- |
| `APPROVED` | `BASIC` | `"You are verified."` | Success screen, then sign in again (§0.5) |
| `IDENTITY_REVIEW` / `COMPLIANCE_REVIEW` / `LOOKED_UP` | `NONE` | `"We are reviewing your details. We will email you when it is done."` | Show the message. Treat all three the same; never explain why. |
| `REJECTED_NOT_FOUND` | `NONE` | `"We could not find that BVN/NIN. Check the number and try again."` | Show the message and the form again |

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 400 | Invalid field | Validation array, e.g. `["BVN and NIN are 11 digits", "Use YYYY-MM-DD"]` |
| 400 | State or LGA not on the list | `"Choose your state and LGA from the list"` / `"Choose your state of origin from the list"` |
| 409 | A submission is already being processed or reviewed | `"A verification is already in progress."` |
| 409 | Already verified | `"You are already verified."` |
| 429 | 3 submissions today | `"You have reached today’s verification limit. Try again tomorrow."` |
| 429 | 10 submissions in all | `"You have used all your verification attempts. Contact support."` |
| 429 | More than 5 requests in an hour (rate limit, §0.4.1) | `"Too many attempts. Try again in N seconds."` + `Retry-After` |
| 503 | Basic is switched off (before launch) | `"Verification is not available yet."` |
| 503 | The provider is unavailable | `"Verification is temporarily unavailable. Please try again later."` (doesn't use an attempt) |

**Integration notes**
- **Never auto-retry** this call: each one can cost a paid lookup. On `503`, let the user press the button again.
- Load the state and LGA pickers from 4.4; don't hard-code them.
- After `APPROVED`, call 4.1 to refresh the screen; the gated features (§0.6) work after the user signs in again.

---

### 4.3 Upload a KYC document

**Endpoint:** `POST /v1/kyc/documents` · **Auth:** **Bearer** · **KYC:** none · **Success:** `201` (new) or `200` (the same file again) · **Rate limit:** 20 per hour

**What it does**
Uploads one ID document. The server checks what the file really is, stores it privately, and records it for review. **Changed 19 Oct 2026 (H8):** it is now a real file upload; the old JSON body with `storageKey`, `mimeType` and `sizeBytes` is refused with `400`.

**Request:** `multipart/form-data` with exactly two fields

| Field | Type | Rules |
| --- | --- | --- |
| `type` | text | One of `NATIONAL_ID, ID_BACK, PASSPORT, DRIVERS_LICENSE, VOTERS_CARD, SELFIE, PROOF_OF_ADDRESS` (BVN and NIN are numbers: use 4.2). For Advanced (4.6) use `NATIONAL_ID`/`PASSPORT`/`DRIVERS_LICENSE` for the front, `ID_BACK` for the back, `SELFIE` for the selfie. |
| `file` | file | JPEG, PNG or WebP photo, or a PDF. **10 MB at most.** The file name and the type your phone says it is are ignored: the server reads the file itself. |

```dart
final form = FormData.fromMap({
  'type': 'PASSPORT',
  'file': await MultipartFile.fromFile(path),
});
await dio.post('/v1/kyc/documents', data: form);
```

**Response** `201` (or `200` with the same body when it was the same file again, e.g. a retry after a timeout: nothing new is created)
```json
{ "id": "3c1e…", "type": "PASSPORT", "status": "PENDING", "uploadedAt": "2026-10-19T09:05:00.000Z" }
```

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 400 | Not a photo or PDF | `"Documents must be a JPEG, PNG or WebP photo, or a PDF"` |
| 400 | No file | `"Choose a file to upload"` |
| 400 | Sent as JSON | `"Send the document as multipart/form-data with two fields: …"` |
| 409 | 10 documents already waiting for review | `"You already have 10 documents waiting for review. …"` |
| 413 | Over 10 MB | `"Each document must be 10 MB or smaller"` |
| 503 | File storage down | `"File storage is unavailable right now. Please try again shortly."` |

**Integration notes**
- **Retrying is safe:** sending the same file again returns the first document.
- Compress photos on the phone (Appendix D.5) to keep uploads quick; the limit is 10 MB.

---

### 4.4 States and LGAs

**Endpoint:** `GET /v1/kyc/states` · **Auth:** none · **KYC:** none · **Success:** `200`

**What it does**
Returns Nigeria's 36 states and the FCT, each with its local government areas, for the address and state-of-origin pickers in 4.2.

**Response** `200`
```json
{ "states": [ { "name": "Abia", "lgas": ["Aba North", "Aba South", "…"] }, { "name": "FCT", "lgas": ["Abaji", "Bwari", "…"] } ] }
```

**Integration notes**
- Send the names **exactly as returned** in 4.2.
- The list rarely changes; cache it for the session.

---

### 4.5 Basic verification: the screen flow

1. **Open the verification screen:** call 4.1.
   - `level: "BASIC"`: show "Verified". Hide the form.
   - `underReview: true`: show "We are reviewing your details". Hide the form (a submit would get `409`).
   - Otherwise show the form, if `attemptsLeftToday` > 0. If it is 0 but `attemptsLeftTotal` > 0, say "Try again tomorrow". If both are 0, say "Contact support".
2. **Fill the form:** ID type (BVN/NIN), the 11-digit number, names **exactly as on the ID**, date of birth, address with the state and LGA from 4.4, and state of origin from 4.4.
3. **Submit (4.2)** with a loading state: it can take up to ~5 seconds. **Never auto-retry it.**
4. **Show the answer** by `state`:
   - `APPROVED`: success, then **sign the user in again**. Their sessions were ended on purpose so the new level takes effect (§0.5).
   - `IDENTITY_REVIEW`, `COMPLIANCE_REVIEW` or `LOOKED_UP`: show `message` ("We are reviewing your details…"). All three look the same to the user. They get an email when it is decided.
   - `REJECTED_NOT_FOUND`: show `message` and let them correct the number.
   - `503`: show `message`; this didn't use an attempt. `429`: show `message`.
5. **When the user comes back**, call 4.1 again; the email tells them it was decided.

**Test numbers** (local backend with the Dojah mock, `DOJAH_USE_MOCK=true` and `KYC_BASIC_ENABLED=true`). Use the exact names shown; the date of birth must match too:

| `idNumber` | Names / date of birth to type | Result |
| --- | --- | --- |
| `33333333333` | Someone Clean, 1995-03-03 | `APPROVED` |
| `22222222222` | John Doe Ajayi, 2000-05-01 | `COMPLIANCE_REVIEW` (until an admin decides) |
| `33333333333` | any other name | `IDENTITY_REVIEW` |
| `11111111111` | anything | `REJECTED_NOT_FOUND` |
| `40200000001` | anything | `503` (provider unavailable; no attempt used) |
| `66666666666` | Test Sanctioned, 1985-06-06 | `COMPLIANCE_REVIEW`, and every gated call then answers `ACCOUNT_UNDER_REVIEW` |

Against the Dojah **sandbox** instead, `22222222222` belongs to "John Doe Adamu", born 2000-05-01.

---

### 4.6 Advanced verification (ID, selfie, proof of address)

Added 21 Oct 2026. Two steps, each checked automatically by Dojah in the background; anything unclear waits for a person.

| Step | Needs | Gives |
| --- | --- | --- |
| **A. ID + selfie** | Basic (`level: BASIC`) | `ADVANCED_IN_PROGRESS` (TIER_2) |
| **B. Proof of address** | Step A done | `ADVANCED` (TIER_3) |

#### Step A: `POST /v1/kyc/advanced/identity`
**Auth:** Bearer · **Success:** `202` · **Rate limit:** 10 per hour

1. Upload with 4.3: the front (`NATIONAL_ID`, `PASSPORT` photo page, or `DRIVERS_LICENSE`), the back if it has one (`ID_BACK`; **required** for a national ID, optional for a driver's licence, **not allowed** for a passport), and a `SELFIE` taken with the camera.
2. Send their ids:
```json
{ "idType": "NATIONAL_ID", "frontDocumentId": "…", "backDocumentId": "…", "selfieDocumentId": "…" }
```
3. Answer `202`: `{ "verificationId": "…", "state": "CHECKING" }`. Show "Checking your documents" and poll `GET /v1/kyc` every 2–3 seconds until `advanced.identity.state` is not `CHECKING` (usually under 15 seconds).
4. On `APPROVED` the customer is signed out (their new level lives in the token): sign in again.

#### Step B: `POST /v1/kyc/advanced/address`
Upload **one** `PROOF_OF_ADDRESS` file, then:
```json
{ "kind": "UTILITY_BILL", "documentId": "…" }
```
`kind` is `UTILITY_BILL`, `BANK_STATEMENT`, `GOVERNMENT_LETTER` or `TENANCY`. **Let the customer choose; none is compulsory.** The document must show their name and address and be issued in the last `advanced.recencyMonths` months; a tenancy agreement must still be running. Same answer and polling as step A, on `advanced.address`.

#### Photos
- **Send camera photos as JPEG** (convert iPhone HEIC first), the whole document in frame, no glare.
- A **PDF** proof of address is accepted but always waits for a person; a photo or screenshot is checked in seconds. A PDF ID or selfie is refused (`400`).

#### Errors

| Status | When | `message` |
| --- | --- | --- |
| 400 | A document id is wrong, not this customer's, the wrong type, a PDF where a photo is needed, or already used | e.g. `"frontDocumentId was not found"`, `"selfieDocumentId must be a SELFIE upload"`, `"frontDocumentId must be a photo, not a PDF"` |
| 403 | Level too low | `"Complete Basic verification first."` / `"Complete your ID and selfie check first."` |
| 403 | All attempts used | `"You've used all your verification attempts. Contact support."` |
| 409 | A check is already running or waiting for a person | `"A check is already in progress."` |
| 409 | Already done | `"Your ID and selfie are already verified."` / `"You are already fully verified."` |
| 429 | Today's attempts used | `"You've used today's attempts. Try again tomorrow."` |
| 503 | Switched off, or Dojah unavailable | `"Advanced verification isn't available right now."` / `"Verification is temporarily unavailable. Please try again later."` |

#### Testing on the local backend (mock Dojah)
Normal photos pass. To see other answers, the test files in `src/dojah/dojah.mock.ts` carry a marker (`id-expired`, `match-borderline`, `live-fail`, `addr-old`, …); the e2e tests in `test/e2e/kyc-advanced.e2e-spec.ts` show how.

---

## 5. Assets & networks

### 5.1 List coins

**Endpoint:** `GET /v1/assets` · **Auth:** none · **KYC:** none · **Success:** `200`

**What it does**
Lists every **crypto** coin the app supports, in display order, with each coin's blockchain networks and what each network allows. Naira isn't included here (it's in 3.2).

**Request**
```http
GET /v1/assets
```

**Response** `200` (real response, trimmed)
```json
[
  {
    "code": "btc",
    "name": "Bitcoin",
    "displayScale": 8,
    "networks": [
      { "id": "btc", "label": "Bitcoin Network", "depositsEnabled": true, "withdrawsEnabled": true, "requiresTag": false, "isDefault": true }
    ]
  },
  {
    "code": "usdt",
    "name": "Tether",
    "displayScale": 6,
    "networks": [
      { "id": "arbitrum",    "label": "Arbitrum One",        "depositsEnabled": true, "withdrawsEnabled": false, "requiresTag": false, "isDefault": false },
      { "id": "bep20",       "label": "Binance Smart Chain", "depositsEnabled": true, "withdrawsEnabled": true,  "requiresTag": false, "isDefault": true  },
      { "id": "ton network", "label": "Ton Network",         "depositsEnabled": true, "withdrawsEnabled": true,  "requiresTag": true,  "isDefault": false },
      { "id": "trc20",       "label": "Tron Network",        "depositsEnabled": true, "withdrawsEnabled": true,  "requiresTag": false, "isDefault": false }
    ]
  }
]
```

| Field | Type | Description |
| --- | --- | --- |
| `code` | string | Coin code, used in every other request |
| `name` | string | Display name |
| `displayScale` | number | **How many decimals to show** for this coin (BTC 8, USDT 6). Naira is 2. |
| `networks[].id` | string | Network id to send in 6.1 / 8.1 / 8.2. Can contain spaces. |
| `networks[].label` | string | Display name of the network |
| `networks[].depositsEnabled` | boolean | Can receive on this network |
| `networks[].withdrawsEnabled` | boolean | Can send on this network |
| `networks[].requiresTag` | boolean | **`true` means a memo / destination tag is mandatory** (XRP, TON…). Without it, funds are lost. |
| `networks[].isDefault` | boolean | Pre-select this network |

**Integration notes**
- Supported today: `btc, usdt, usdc, eth, bnb, xrp, ltc, sol, bch, doge, trx, pol, link, ada, sui`. **Don't hard-code this list**, because admins can change it.
- Cache it for the session; it rarely changes.

---

### 5.2 List a coin's networks (for deposit or withdraw)

**Endpoint:** `GET /v1/assets/{code}/networks?purpose={deposit|withdraw}` · **Auth:** none · **KYC:** none · **Success:** `200`

**What it does**
Returns only the networks of one coin that are open for **depositing** or for **withdrawing**, with the default first and the number of confirmations each needs.

**Request**

| Param | In | Type | Required | Values |
| --- | --- | --- | --- | --- |
| `code` | path | string | ✅ | Coin code, e.g. `usdt` |
| `purpose` | query | string | ❌ (default `deposit`) | `deposit` or `withdraw` |

```http
GET /v1/assets/usdt/networks?purpose=withdraw
```

**Response** `200` (real response, trimmed)
```json
[
  { "id": "bep20",       "label": "Binance Smart Chain", "requiresTag": false, "confirmations": 1,  "isDefault": true  },
  { "id": "erc20",       "label": "Ethereum Network",    "requiresTag": false, "confirmations": 12, "isDefault": false },
  { "id": "ton network", "label": "Ton Network",         "requiresTag": true,  "confirmations": 1,  "isDefault": false }
]
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Network id |
| `label` | string | Display name |
| `requiresTag` | boolean | Memo / tag mandatory |
| `confirmations` | number | Block confirmations before a deposit is credited (for "usually takes X confirmations") |
| `isDefault` | boolean | Pre-select it |

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 404 | Unknown coin | `"Unknown asset: xyz"` |

**Integration notes**
- **Always ask for the right `purpose`.** Some networks are deposit-only: USDT on `arbitrum` appears for `deposit` but not `withdraw`.
- Any `purpose` value other than `deposit` is treated as `withdraw`.

---

## 6. Deposits

### 6.1 Get (or create) a deposit address

**Endpoint:** `POST /v1/deposits/address` · **Auth:** **Bearer** · **KYC:** **TIER_1** · **Success:** `201`

**What it does**
Returns the user's **permanent** deposit address for one coin on one network, creating it the first time. Creating an address takes a few seconds in the background, so **the first call usually returns `address: null`**. Calling again is safe: it never creates a second address.

**Request**

| Field | Type | Required | Rules | Example |
| --- | --- | --- | --- | --- |
| `asset` | string | ✅ | Letters/numbers, max 20 | `"usdt"` |
| `network` | string | ✅ | Network `id` from 5.2 (`purpose=deposit`), max 40 | `"trc20"` |

```http
POST /v1/deposits/address
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json

{ "asset": "usdt", "network": "trc20" }
```

**Response** `201`, first call (still being generated):
```json
{
  "asset": "usdt",
  "network": "trc20",
  "networkLabel": "Tron Network",
  "status": "PENDING",
  "address": null,
  "destinationTag": null,
  "requiresTag": false,
  "confirmations": 1,
  "usable": false
}
```

**Response** `201` when ready (example for a coin that needs a tag):
```json
{
  "asset": "xrp",
  "network": "ripple",
  "networkLabel": "Ripple Network",
  "status": "ACTIVE",
  "address": "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY",
  "destinationTag": "482910",
  "requiresTag": true,
  "confirmations": 1,
  "usable": true
}
```

| Field | Type | Description |
| --- | --- | --- |
| `asset` | string | Coin |
| `network` | string | Network id |
| `networkLabel` | string | Network display name |
| `status` | string | `PENDING` (generating) / `ACTIVE` / `FAILED` / `DISABLED` |
| `address` | string \| null | The address. **`null` while generating.** |
| `destinationTag` | string \| null | Memo / tag, for networks that need one |
| `requiresTag` | boolean | If `true`, the user must include `destinationTag` when sending |
| `confirmations` | number | Confirmations needed before crediting |
| `usable` | boolean | **Only show the address / QR when this is `true`** |

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 403 | Not verified, verification still completing, or account under review | One of the three bodies in §0.6 |
| 403 | Deposits paused by admin | `"Deposits are temporarily paused."` |
| 404 | Unknown coin | `"Unknown asset: xyz"` |
| 404 | Coin not on that network | `"USDT is not available on xyz"` |
| 400 | Deposits switched off on that network | `"Deposits are disabled for USDT on Arbitrum One"` |
| 400 | Bad asset format | `["Invalid asset code"]` |

**Integration notes**
- While `usable` is `false`, show a spinner ("Generating your address…") and **call this same endpoint again every 3–5 s**. Stop after ~2 minutes; a push `address.ready` arrives when it's done.
- **Never show or copy a `null` address.**
- If `requiresTag` is `true`, show the `destinationTag` as large as the address, with a warning: "You MUST include this tag or your deposit will be lost."
- When funds arrive the user gets pushes `deposit.detected` and then `deposit.credited`. Refresh 3.2.

---

### 6.2 List my deposit addresses

**Endpoint:** `GET /v1/deposits/addresses` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Returns every deposit address the user has generated, across all coins and networks.

**Request**
```http
GET /v1/deposits/addresses
Authorization: Bearer eyJhbGciOi…
```

**Response** `200`: an array of the **same object as 6.1**, sorted by coin then network.
```json
[
  { "asset": "usdt", "network": "trc20", "networkLabel": "Tron Network", "status": "ACTIVE", "address": "TQrY8tryqsYVCYS3MFbtffiPp2ccyn4STm", "destinationTag": null, "requiresTag": false, "confirmations": 1, "usable": true }
]
```

---

### 6.3 Deposit history

**Endpoint:** `GET /v1/deposits?limit={n}` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Lists money that came **into** the user's balance: crypto deposits, naira deposits, and **referral rewards**. Newest first.

**Request**

| Param | In | Type | Required | Rules |
| --- | --- | --- | --- | --- |
| `limit` | query | integer | ❌ | Default 50, max 100 |

```http
GET /v1/deposits?limit=50
Authorization: Bearer eyJhbGciOi…
```

**Response** `200`
```json
[
  { "id": "c1d2e3f4-…", "asset": "usdt", "amount": "150",    "status": "COMPLETED", "reason": null, "provider": "QUIDAX",      "counterpartyBank": null,          "createdAt": "2026-10-02T08:00:00.000Z", "completedAt": "2026-10-02T08:03:00.000Z" },
  { "id": "c2e3f4a5-…", "asset": "ngn",  "amount": "1000",   "status": "COMPLETED", "reason": null, "provider": "PAYREP", "counterpartyBank": "Access Bank", "createdAt": "2026-10-01T15:00:00.000Z", "completedAt": "2026-10-01T15:00:00.000Z" },
  { "id": "c3f4a5b6-…", "asset": "ngn",  "amount": "750000", "status": "ON_HOLD",   "reason": "That would take you past your ₦500,000 daily deposit limit. You have ₦200,000 left today.", "provider": "PAYREP", "counterpartyBank": "GTBank", "createdAt": "2026-10-01T14:00:00.000Z", "completedAt": null }
]
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Transaction id (works with 7.4) |
| `asset` | string | Coin or `ngn` |
| `amount` | string | Full precision; format with the coin's `displayScale` |
| `status` | string | `PENDING` (confirming) / `ON_HOLD` / `COMPLETED` / `FAILED` |
| `reason` | string \| null | Why it's on hold or failed |
| `provider` | string | `PAYREP` for a bank transfer into the naira account (6.4); `FLUTTERWAVE` on deposits from before 21 Oct 2026; `QUIDAX` otherwise |
| `counterpartyBank` | string \| null | The sending bank, for a naira bank transfer |
| `createdAt` | string | |
| `completedAt` | string \| null | When it was credited |

**Integration notes**
- Gift-card payouts are **not** here; they're in 9.4.
- There's no network, address or blockchain hash per deposit yet (Appendix F).
- No pages yet: `limit` max 100.
- Known backend bug: after a **buy**, a `PENDING` "deposit" of the bought coin may appear here. It's not an app bug (Appendix F).

---

### 6.4 Get my naira deposit account

**Endpoint:** `GET /v1/deposits/ngn/account` · **Auth:** **Bearer** · **KYC:** none (see `eligible`) · **Success:** `200`

**What it does**
Returns the user's permanent naira account number. A bank transfer into it from any Nigerian bank lands in their naira balance, usually within a minute. A user has at most one, and it doesn't expire.

**Request**
```http
GET /v1/deposits/ngn/account
Authorization: Bearer eyJhbGciOi…
```

**Response** `200`
```json
{ "accountNumber": "2070174481", "accountName": "DAVOCHAIN/ADA OBI", "bankName": "Payrep MFB", "status": "ACTIVE" }
```

| Field | Type | Description |
| --- | --- | --- |
| `accountNumber` | string | 10 digits. Show it with a copy button. |
| `accountName` | string | The name the sender's banking app shows when they type the number |
| `bankName` | string | The bank to pick in the sender's app |
| `status` | string | `ACTIVE`, or `INACTIVE` while the account is switched off (for example during a suspension). Never show an `INACTIVE` number as something to pay into: money sent to it is held for an admin, not credited. |

**Errors**

| Status | `code` | Meaning |
| --- | --- | --- |
| 404 | `NO_VIRTUAL_ACCOUNT` | No account yet. `eligible` says whether 6.5 will work; `reason` says why not. |

```json
{ "statusCode": 404, "code": "NO_VIRTUAL_ACCOUNT", "eligible": false, "reason": "Verify your identity (Tier 1) to get a naira account.", "message": "You have no naira deposit account yet." }
```

Possible `reason` values when `eligible` is `false`:

| `reason` | Meaning |
| --- | --- |
| `"Verify your identity (Tier 1) to get a naira account."` | Not Basic yet: open 4.2 |
| `"Your verification is still being completed."` | Basic was submitted and is still finishing |
| `"Your account is under review. Contact support."` | Under review. Show it as-is; never explain why. |
| `"Your account is not active. Contact support."` | Suspended or closed |
| `"Naira deposits are not available yet."` / `"Naira deposits are temporarily unavailable. Try again later."` | Switched off, or the provider is down |

**Integration notes**
- Call it when the naira deposit screen opens. On 404 with `eligible: true`, offer "Get my account number" (6.5). With `eligible: false`, show `reason`.
- A deposit shows up in 6.3 and as a `deposit.credited` push. A deposit over the user's limit, or into an account that is switched off, shows as `ON_HOLD` (push `deposit.on_hold`) until an admin reviews it.

---

### 6.5 Open my naira deposit account

**Endpoint:** `POST /v1/deposits/ngn/account` · **Auth:** **Bearer** · **KYC:** Basic (`TIER_1`) approved **and** not under review (checked server-side) · **Success:** `201`, `200` or `202`

**What it does**
Creates the user's permanent naira account at Payrep MFB, DavoChain's naira provider. The user re-enters the BVN or NIN they verified with in 4.2. It is checked against what DavoChain holds, sent once to Payrep, and never stored.

**Request**

| Field | In | Type | Required | Rules |
| --- | --- | --- | --- | --- |
| `bvn` | body | string | one of the two | Exactly 11 digits |
| `nin` | body | string | one of the two | Exactly 11 digits |

Send exactly one, and the same kind the user verified with in 4.2.

```http
POST /v1/deposits/ngn/account
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json

{ "bvn": "22222223883" }
```

**Responses**

| Status | Body | Meaning |
| --- | --- | --- |
| `201` | the 6.4 object | Created |
| `200` | the 6.4 object | The user already had one; nothing new was created |
| `202` | `{ "status": "PENDING", "message": "We're setting up your account. Try again in a few minutes." }` | Payrep didn't confirm in time. Poll 6.4 every 30 seconds for a few minutes. If it still answers 404, let the user try 6.5 again. |

**Errors**

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | — | A field isn't 11 digits. `message` is an array of validation messages, as everywhere (0.4). |
| 400 | `ONE_IDENTITY_NUMBER` | Both or neither were sent |
| 400 | `IDENTITY_TYPE_MISMATCH` | The user verified with the other kind of number |
| 400 | `IDENTITY_MISMATCH` | Not the number the user verified with |
| 400 | `PROVIDER_REJECTED` | Payrep refused the number (it could not verify it) |
| 403 | `NOT_ELIGIBLE` | Show `message` (the same text as `reason` in 6.4) |
| 409 | `ALREADY_CREATING` | A request is already in progress (wait a minute), or the last try got no clear answer from Payrep (202) and is being checked: the customer can try again after 30 minutes. Show `message`. |
| 429 | `TOO_MANY_ATTEMPTS` | Five attempts in 24 hours; try tomorrow |
| 503 | `DEPOSITS_UNAVAILABLE` | Temporarily unavailable; try later |

**Integration notes**
- Never keep the BVN or NIN on the device. Send it once and clear the field.
- Every attempt counts toward the five a day, including a wrong number.

---

## 7. Trading (buy, sell, swap)

Every trade takes **two calls**: (1) **get a quote**, a price valid for **12 seconds**; (2) **execute** that quote.

### 7.1 Get a quote

**Endpoint:** `POST /v1/quotes` · **Auth:** **Bearer** · **KYC:** **TIER_1** · **Success:** `201`

**What it does**
Prices a buy, sell or swap and returns a **quote valid for 12 seconds**: exactly what the user pays, what they receive, the rate, any fee, and the min/max trade size. It also checks the user has enough balance.

**Request**

| Field | Type | Required | Rules | Example |
| --- | --- | --- | --- | --- |
| `side` | string | ✅ | `"buy"`, `"sell"` or `"swap"` (lowercase) | `"buy"` |
| `fromAsset` | string | ✅ | What the user pays with. 2–20 letters/numbers. | `"ngn"` |
| `toAsset` | string | ✅ | What the user receives. 2–20 letters/numbers. | `"btc"` |
| `amount` | string | ✅ | Positive decimal, **always in `fromAsset` units** | `"100000"` |

Both assets are **always required**:

| Trade | `side` | `fromAsset` | `toAsset` | `amount` means |
| --- | --- | --- | --- | --- |
| Buy BTC with naira | `buy` | `"ngn"` | `"btc"` | Naira to spend |
| Sell BTC for naira | `sell` | `"btc"` | `"ngn"` | BTC to sell |
| Swap USDT to BTC | `swap` | `"usdt"` | `"btc"` | USDT to swap |

```http
POST /v1/quotes
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json

{ "side": "buy", "fromAsset": "ngn", "toAsset": "btc", "amount": "100000" }
```

**Response** `201` (buy)
```json
{
  "quoteId": "5f0e2c1a-8d3b-4c6e-9f21-7a4b3c2d1e0f",
  "side": "BUY",
  "fromAsset": "ngn",
  "toAsset": "btc",
  "fromAmount": "99998.40",
  "toAmount": "0.00067342",
  "rate": "1485.0000",
  "fee": "0.00000000",
  "feeAsset": null,
  "minimum": "18.00",
  "maximum": "2000.00",
  "expiresAt": "2026-10-02T10:00:12.000Z",
  "ttlSeconds": 12,
  "availableBalance": "250000.00"
}
```

**Response** `201` (swap): note the real fee:
```json
{
  "quoteId": "7a1b…",
  "side": "SWAP",
  "fromAsset": "usdt", "toAsset": "btc",
  "fromAmount": "50.00000000", "toAmount": "0.00071234",
  "rate": "0.0000",
  "fee": "0.00002950", "feeAsset": "btc",
  "minimum": "4.00", "maximum": "2000.00",
  "expiresAt": "2026-10-02T10:00:12.000Z", "ttlSeconds": 12,
  "availableBalance": "120.000000"
}
```

| Field | Type | Description |
| --- | --- | --- |
| `quoteId` | string | Send this to 7.2 |
| `side` | string | `BUY` / `SELL` / `SWAP` (**uppercase** in the response) |
| `fromAsset`, `toAsset` | string | |
| `fromAmount` | string | **What will actually be taken from the balance.** On a buy it can be a little *less* than the amount typed (the coin amount is rounded down, then the naira is re-priced from it). Show this, not the typed amount. NGN 2 decimals, coins 8. |
| `toAmount` | string | What the user receives (8 decimals for coins, 2 for NGN) |
| `rate` | string | **Buy/sell:** naira per **US dollar**, with DavoChain's margin included (e.g. "₦1,485 per $1"). **Swap:** `toAsset` per 1 `fromAsset`, to 10 significant digits (e.g. USDT→BTC `"0.00001423498765"`). |
| `fee` | string | Buy/sell: always zero (the margin is inside the rate), so show ₦0 or no fee line. Swap: a real fee, already taken out of `toAmount`. **Show it.** |
| `feeAsset` | string \| null | The coin the swap fee is charged in |
| `minimum`, `maximum` | string | Allowed trade size **in US dollars**. Changes with price. |
| `expiresAt` | string | When the quote dies |
| `ttlSeconds` | number | `12`. Drive the countdown with this. |
| `availableBalance` | string | User's spendable balance of `fromAsset` |

**Errors**

| Status | When | `message` (example) |
| --- | --- | --- |
| 400 | Below the minimum | `"Minimum BTC trade is $18.00. This one is worth $12.00."` |
| 400 | Above the maximum | `"Maximum single trade is $2000.00."` |
| 400 | Amount too small for the coin | `"Amount is too small to trade in this coin"` / `"Amount is too small to swap"` |
| 400 | Not enough balance | `"Insufficient naira balance. You have ₦5000.00."` / `"Insufficient BTC balance. You have 0.0001."` |
| 400 | Swap below twice its fee | `"Minimum swap is $4.00 worth — the $2.00 fee would take too large a share"` |
| 400 | Same coin on both sides | `"Choose two different coins"` |
| 404 | Unknown coin | `"Unknown asset: xyz"` |
| 400 | Outside the coin's transfer limit | `"Minimum BTC transfer is 0.00015"` / `"Maximum BTC transfer is 5"` |
| 403 | Trading paused | `"Trading is temporarily paused. Please try again shortly."` / `"BTC is temporarily unavailable for trading."` |
| 403 | Not verified, verification still completing, or account under review | One of the three bodies in §0.6 |
| 500 | Price provider unreachable | Generic. "Couldn't get a price, try again." |

**Integration notes (important)**
1. **Debounce the amount field ~400 ms** before asking for a quote.
2. Show a **12-second countdown**. At 0, **fade and disable Continue** and show "Refresh rate".
3. **Never refresh the quote automatically** while the user looks at it. Only when they change the amount or tap refresh.
4. Convert `minimum` / `maximum` into the currency on screen and validate **before** the user taps Continue.

---

### 7.2 Execute a quote (place the trade)

**Endpoint:** `POST /v1/trades` · **Auth:** **Bearer** · **KYC:** **TIER_1** · **Success:** `201`

**What it does**
Executes a quote from 7.1. **This moves money.** A quote can be used **once**, only by the user it was made for, and only within its 12 seconds. Buys and sells usually finish immediately; swaps finish a little later.

**Request**

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <accessToken>` |
| `Idempotency-Key` | **Required.** New UUID per tap; the same one on retries (§0.7). |

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `quoteId` | string | ✅ | From 7.1, max 64 |

```http
POST /v1/trades
Authorization: Bearer eyJhbGciOi…
Idempotency-Key: 3b8f1c2e-6a4d-4f7b-9c1e-2d5a8b7f0e13
Content-Type: application/json

{ "quoteId": "5f0e2c1a-8d3b-4c6e-9f21-7a4b3c2d1e0f" }
```

**Response** `201` (buy or sell, finished)
```json
{
  "transactionId": "a71c9e3b-5d2f-4a1e-8c6b-2f9d0e7a3b14",
  "status": "COMPLETED",
  "fromAsset": "ngn",
  "fromAmount": "99998.40",
  "toAsset": "btc",
  "toAmount": "0.00067342",
  "rate": "1485.0000"
}
```

**Response** `201` (swap, still finishing)
```json
{
  "transactionId": "b82d…",
  "status": "PROCESSING",
  "fromAsset": "usdt", "fromAmount": "50.00000000",
  "toAsset": "btc", "toAmount": "0.00071234",
  "rate": "0.00001475"
}
```

| Field | Type | Description |
| --- | --- | --- |
| `transactionId` | string | Use with 7.4 to check status |
| `status` | string | `COMPLETED` (done), `PROCESSING` (swap finishing), or `RECONCILING` (outcome being confirmed, funds held safely, §0.8) |
| `fromAsset`, `fromAmount` | string | What was taken |
| `toAsset`, `toAmount` | string | What was / will be received |
| `rate` | string | Rate used. **`"0"` when `RECONCILING`.** |

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 400 | Missing header | `"Idempotency-Key header is required for this request"` |
| 409 | Key reused with a different body | `"This Idempotency-Key was already used with a different request"` |
| 409 | Same key still running | `"This request is still processing"` |
| 404 | Quote doesn't exist / not this user's | `"Quote not found"` |
| 400 | Quote already used | `"This quote has already been used"` |
| 400 | Quote expired | `"The rate has expired. Please refresh and try again."`: get a new quote |
| 400 | Coin out of stock | `"BTC is temporarily unavailable to buy. Please try again shortly."` |
| 400 | Balance dropped since the quote | `"Insufficient NGN balance: need 99998.4, have 5000"` |
| 400 | Provider refused the trade | `"<reason>. Nothing was deducted from your balance."` |
| 409 | Two changes collided | `"Someone else changed this at the same moment. Try again."`: get a **new** quote and key |
| 403 | Trading paused / not verified | as in 7.1 |

**Integration notes**
- `COMPLETED`: success screen, refresh 3.2.
- `PROCESSING` (swaps): progress screen. Poll **7.4** every 5 s while it's open; push `trade.completed` or `trade.failed` arrives at the end.
- `RECONCILING`: "We're confirming this with our provider. Your funds are safe." **No retry button.**
- Any `400`: **nothing was deducted**. Show the message.
- On a timeout, retry with the **same** `Idempotency-Key` (Appendix D has the code).

---

### 7.3 Trade history

**Endpoint:** `GET /v1/trades?limit={n}` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Lists the user's buys, sells and swaps, newest first.

> **Since 16 Oct 2026** this list can also hold a **balance correction**: `"type": "ADJUSTMENT"` with `"label": "Balance correction"`. It means our team put the customer's balance right so it matches what is really held. Money **in** has `toAsset`/`toAmount`; money **out** has `fromAsset`/`fromAmount`. Show the `label`; there is no rate or reason to show.

**Request**

| Param | In | Type | Required | Rules |
| --- | --- | --- | --- | --- |
| `limit` | query | integer | ❌ | Default 50, max 100 |

```http
GET /v1/trades?limit=50
Authorization: Bearer eyJhbGciOi…
```

**Response** `200`
```json
[
  {
    "id": "a71c9e3b-5d2f-4a1e-8c6b-2f9d0e7a3b14",
    "type": "BUY",
    "status": "COMPLETED",
    "fromAsset": "ngn",
    "fromAmount": "99998.4",
    "toAsset": "btc",
    "toAmount": "0.00067342",
    "rate": "1485.0000",
    "fee": "0",
    "reason": null,
    "createdAt": "2026-10-02T10:00:05.000Z",
    "completedAt": "2026-10-02T10:00:06.000Z"
  }
]
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Transaction id |
| `type` | string | `BUY` / `SELL` / `SWAP` |
| `status` | string | §0.8 |
| `fromAsset`, `fromAmount` | string | Paid (full precision) |
| `toAsset`, `toAmount` | string | Received (full precision) |
| `rate` | string \| null | 4 decimals |
| `fee` | string | Always `"0"` here (a swap's fee is already taken out of `toAmount`) |
| `reason` | string \| null | Set when `FAILED` or `RECONCILING` |
| `createdAt`, `completedAt` | string / null | |

---

### 7.4 Get one transaction (status polling)

**Endpoint:** `GET /v1/trades/{id}` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Returns the current state of **any one of the user's transactions** by id: trades, and also withdrawals, deposits and gift-card payouts. Use it to **poll** a swap or withdrawal until it finishes.

**Request**

| Param | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | ✅ |

```http
GET /v1/trades/b82d1f0e-…
Authorization: Bearer eyJhbGciOi…
```

**Response** `200`
```json
{
  "id": "b82d1f0e-…",
  "type": "SWAP",
  "status": "PROCESSING",
  "fromAsset": "usdt",
  "fromAmount": "50",
  "toAsset": "btc",
  "toAmount": "0.00071234",
  "reason": null,
  "createdAt": "2026-10-02T10:02:00.000Z",
  "completedAt": null
}
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | |
| `type` | string | `BUY`, `SELL`, `SWAP`, `DEPOSIT`, `WITHDRAWAL` or `GIFT_CARD` |
| `status` | string | §0.8 |
| `fromAsset`, `fromAmount` | string \| null | `null` for deposits and gift-card payouts |
| `toAsset`, `toAmount` | string \| null | |
| `reason` | string \| null | |
| `createdAt`, `completedAt` | string / null | |

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 404 | Not found / not this user's | `"No such transaction"` |

**Integration notes**
- Poll every **5 s** only while the screen is visible, and stop at `COMPLETED` or `FAILED`.
- For `RECONCILING`, don't poll aggressively. Re-check when the screen opens; a push arrives when it's resolved.

---

## 8. Withdrawals

### 8.1 Crypto withdrawal fee quote

**Endpoint:** `GET /v1/withdrawals/quote?asset={code}&amount={amount}&network={id}` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Shows what a crypto withdrawal will cost **before** the user confirms: the blockchain network fee and DavoChain's fee as separate lines, and the total that will leave their balance.

**Request**

| Param | In | Type | Required | Rules | Example |
| --- | --- | --- | --- | --- | --- |
| `asset` | query | string | ✅ | Coin code | `usdt` |
| `amount` | query | string | ✅ | **Valid positive decimal.** What the recipient should receive. | `100` |
| `network` | query | string | ✅ | Network id from 5.2 (`purpose=withdraw`), URL-encoded | `trc20` |

```http
GET /v1/withdrawals/quote?asset=usdt&amount=100&network=trc20
Authorization: Bearer eyJhbGciOi…
```

**Response** `200`
```json
{
  "asset": "usdt",
  "network": "trc20",
  "amount": "100.000000",
  "networkFee": "1.000000",
  "platformFee": "1.000000",
  "platformFeeUsd": "1.00",
  "totalFee": "2.000000",
  "totalDeducted": "102.000000",
  "youReceive": "100.000000"
}
```

| Field | Type | Description |
| --- | --- | --- |
| `asset`, `network` | string | Echo of the request |
| `amount` | string | Amount the recipient gets |
| `networkFee` | string | Blockchain fee, in the coin |
| `platformFee` | string | DavoChain's fee, in the coin |
| `platformFeeUsd` | string \| null | DavoChain's fee in US dollars (may be `null`) |
| `totalFee` | string | `networkFee + platformFee` |
| `totalDeducted` | string | **What leaves the balance:** `amount + totalFee` |
| `youReceive` | string | Same as `amount` |

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 404 | Unknown coin | `"Unknown asset: xyz"` |
| 503 | Network fee unavailable | `"Unable to retrieve the network fee. Please try again shortly."` |
| 500 | `amount` / `asset` missing or not a number | Generic (backend bug). **Always validate before calling.** |

**Integration notes**
- Show "Network fee" and "DavoChain fee" as **two separate lines**, then "Total deducted".
- Enable Confirm only when `totalDeducted ≤ available` (from 3.2).

---

### 8.2 Withdraw crypto

**Endpoint:** `POST /v1/withdrawals/crypto` · **Auth:** **Bearer** · **KYC:** **TIER_1** · **Success:** `201`

**What it does**
Sends crypto from the user's balance to an external wallet address. **This moves money.** The funds are held right away; the withdrawal then completes in the background (minutes). The user gets a "withdrawal requested" email and push immediately.

**Request**

| Header | Value |
| --- | --- |
| `Idempotency-Key` | **Required.** New UUID per tap, same one on retries. |

| Field | Type | Required | Rules | Example |
| --- | --- | --- | --- | --- |
| `amount` | string | ✅ | Positive decimal: **what the recipient receives** | `"100"` |
| `savedCryptoAddressId` | string | ✅ | From 8.9 (since 15 Oct 2026; the coin, network, address and tag come from the saved address) | `"6c0f…"` |

> Sending `asset`, `network`, `address` or `destinationTag` (the old body) answers `400 "Choose a saved address"`. A saved address still in its wait answers `403 DESTINATION_COOLING_OFF` (8.8).

```http
POST /v1/withdrawals/crypto
Authorization: Bearer eyJhbGciOi…
Idempotency-Key: 9d2c4e1a-7b3f-4a8e-b6d1-0f5c2e9a8b47
Content-Type: application/json

{ "amount": "100", "savedCryptoAddressId": "6c0f2b1e-8a4d-4f3c-9e7a-2d5b1c8f0a64" }
```

**Response** `201`
```json
{
  "transactionId": "e4b2d8f1-3a6c-4e9b-b7d2-1c5f8a0e6d39",
  "status": "PROCESSING",
  "asset": "usdt",
  "amount": "100.000000",
  "address": "TQrY8tryqsYVCYS3MFbtffiPp2ccyn4STm"
}
```

| Field | Type | Description |
| --- | --- | --- |
| `transactionId` | string | Poll with 7.4 |
| `status` | string | `PROCESSING` (normal) or `RECONCILING` (§0.8). Later becomes `COMPLETED` or `FAILED`. |
| `asset` | string | |
| `amount` | string | What the recipient will receive |
| `address` | string | Destination |

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 403 | Not verified, verification still completing, or account under review | One of the three bodies in §0.6 |
| 403 | Withdrawals paused | `"Withdrawals are temporarily paused."` |
| 404 | Unknown coin | `"Unknown asset: xyz"` |
| 400 | Network not offered | `"USDT is not available on xyz"` |
| 400 | Network withdrawals off | `"Withdrawals are disabled for USDT on Arbitrum One"` |
| 400 | Tag missing | `"Ton Network requires a destination tag. Without it the funds cannot be credited."` |
| 400 | Address format wrong | `"That does not look like a valid Tron Network address"` |
| 400 | Amount zero or negative | `"Enter an amount greater than zero"` |
| 400 | Not enough balance **including fees** | `"Insufficient USDT balance: need 102, have 80"` |
| 503 | Fee lookup failed | `"Unable to retrieve the network fee. Please try again shortly."` |
| 400 | Provider refused | `"<reason>. Nothing was deducted from your balance."` |
| 400 / 409 | Idempotency problems | §0.7 |

**Integration notes**
- The balance goes down by `amount + platform fee + network fee`. Always show 8.1 first. The network fee is re-checked at submit, so it can differ very slightly.
- Pushes: `withdrawal.submitted` now, then `withdrawal.sent` (with the blockchain hash in the text) or `withdrawal.rejected` (money returned).
- Show a strong warning for the address and tag ("Crypto sent to a wrong address can't be recovered").
- A "verify it's you" step (OTP/2FA) and saved addresses are planned. Design the confirm screen so they can slot in (Appendix F).

---

### 8.3 Withdrawal history

**Endpoint:** `GET /v1/withdrawals?limit={n}` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Lists the user's crypto and naira withdrawals, newest first, with the fee breakdown.

**Request**

| Param | In | Type | Required | Rules |
| --- | --- | --- | --- | --- |
| `limit` | query | integer | ❌ | Default 50, max 100 |

```http
GET /v1/withdrawals?limit=50
Authorization: Bearer eyJhbGciOi…
```

**Response** `200`
```json
[
  {
    "id": "e4b2d8f1-3a6c-4e9b-b7d2-1c5f8a0e6d39",
    "asset": "usdt",
    "amount": "100.00000000",
    "totalDebited": "102.00000000",
    "feeAmount": "1.00000000",
    "networkFee": "1.00000000",
    "bankName": null,
    "accountNumberLast4": null,
    "status": "PROCESSING",
    "reason": null,
    "createdAt": "2026-10-02T11:00:00.000Z",
    "completedAt": null
  },
  {
    "id": "f5c3…",
    "asset": "ngn",
    "amount": "50000.00",
    "totalDebited": "50100.00",
    "feeAmount": "100.00",
    "networkFee": "10.75",
    "bankName": "Access Bank",
    "accountNumberLast4": "6789",
    "status": "COMPLETED",
    "reason": null,
    "createdAt": "2026-10-01T11:00:00.000Z",
    "completedAt": "2026-10-01T11:04:00.000Z"
  }
]
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Transaction id (works with 7.4) |
| `asset` | string | Coin or `ngn` |
| `amount` | string | What the recipient got |
| `totalDebited` | string | What left the balance |
| `feeAmount` | string | DavoChain's fee |
| `networkFee` | string | Blockchain / provider fee. On naira withdrawals this is the provider's own cost, **not** charged to the user, so don't show it as a user fee. |
| `bankName`, `accountNumberLast4` | string \| null | Naira withdrawals only |
| `status` | string | §0.8 |
| `reason` | string \| null | Why it failed |
| `createdAt`, `completedAt` | string / null | |

**Integration notes**
- The destination crypto address and the blockchain hash aren't stored per withdrawal yet (Appendix F).

---

> ### ⚠️ Naira (NGN) bank withdrawals can be switched off at any time
> Endpoints 8.5–8.7 return `403 "Naira withdrawals are temporarily unavailable."` whenever naira withdrawals are off. That happens when the server setting is off, or when an admin has switched them off in the dashboard (System → Withdrawals). **Always gate the submit button on `payoutAvailable` from 8.4**, and handle this 403 even after a fresh 8.4, because the switch can flip between the two calls. 8.4 itself always works.

### 8.4 Naira withdrawal fee quote

**Endpoint:** `GET /v1/withdrawals/quote/ngn?amount={amount}` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Shows the fee for cashing out naira to a bank, the total that will leave the balance, the user's naira withdrawal limits for today, and **whether bank payouts are switched on** (`payoutAvailable`).

**Request**

| Param | In | Type | Required | Rules | Example |
| --- | --- | --- | --- | --- | --- |
| `amount` | query | string | ✅ | Positive decimal (naira) | `50000` |

```http
GET /v1/withdrawals/quote/ngn?amount=50000
Authorization: Bearer eyJhbGciOi…
```

**Response** `200`
```json
{
  "asset": "ngn",
  "amount": "50000.00",
  "feeNgn": "100.00",
  "totalDebited": "50100.00",
  "youReceive": "50000.00",
  "band": { "minAmount": "10000.00", "maxAmount": "100000.00" },
  "feeConfigured": true,
  "limit": {
    "allowed": true,
    "reason": null,
    "singleLimit": "200000.00",
    "dailyLimit": "500000.00",
    "usedToday": "0.00",
    "remainingToday": "500000.00"
  },
  "payoutAvailable": false
}
```

| Field | Type | Description |
| --- | --- | --- |
| `amount` | string | Amount that reaches the bank |
| `feeNgn` | string | DavoChain's fee |
| `totalDebited` | string | `amount + feeNgn` (what leaves the balance) |
| `youReceive` | string | Same as `amount` |
| `band` | object \| null | The fee bracket this amount falls in (`maxAmount` `null` = no upper limit). `null` if no fee is set. |
| `feeConfigured` | boolean | `false` = no fee set (fee is ₦0) |
| `limit.allowed` | boolean | Whether this amount is within the user's limits |
| `limit.reason` | string \| null | **Show it when `allowed` is false**, e.g. `"Your account cannot withdraw naira yet. Complete the next verification tier to unlock it."` |
| `limit.singleLimit`, `limit.dailyLimit` | string | Per-transaction and per-day limits |
| `limit.usedToday`, `limit.remainingToday` | string | Today's usage |
| `payoutAvailable` | boolean | **Bank payouts switched on?** Disable the submit button when `false`. |

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 400 | Amount ≤ 0 | `"Enter an amount greater than zero"` |
| 500 | `amount` missing or not a number | Generic. Validate first. |

---

### 8.5 List banks

**Endpoint:** `GET /v1/withdrawals/ngn/banks` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Returns the Nigerian banks the user can withdraw naira to.

**Request**
```http
GET /v1/withdrawals/ngn/banks
Authorization: Bearer eyJhbGciOi…
```

**Response** `200`
```json
[
  { "code": "000014", "name": "Access Bank" },
  { "code": "000013", "name": "GTBank" }
]
```

| Field | Type | Description |
| --- | --- | --- |
| `code` | string | The bank's 6-digit NIP code. Send as `bankCode` in 8.6 / 8.8 |
| `name` | string | Display name |

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 403 | Naira withdrawals switched off | `"Naira withdrawals are temporarily unavailable."` |

**Integration notes**
- Use a searchable picker; cache the list for the session.

---

### 8.6 Verify a bank account

**Endpoint:** `POST /v1/withdrawals/ngn/verify-account` · **Auth:** **Bearer** · **KYC:** **TIER_1** · **Success:** `201`

**What it does**
Looks up the **account holder's name** for an account number and bank, so the user can confirm they're paying the right account. Doesn't move money.

**Request**

| Field | Type | Required | Rules | Example |
| --- | --- | --- | --- | --- |
| `accountNumber` | string | ✅ | Exactly 10 digits | `"0123456789"` |
| `bankCode` | string | ✅ | `code` from 8.5, letters/numbers, 1–20 | `"000014"` |

```http
POST /v1/withdrawals/ngn/verify-account
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json

{ "accountNumber": "0123456789", "bankCode": "000014" }
```

**Response** `201`
```json
{ "accountName": "ADA OBI", "accountNumberLast4": "6789", "bankCode": "000014" }
```

| Field | Type | Description |
| --- | --- | --- |
| `accountName` | string | Name on the account. Show it for confirmation. |
| `accountNumberLast4` | string | Last 4 digits |
| `bankCode` | string | Echo |

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 400 | Account can't be verified | `"Unable to verify those bank details. Check the account and bank."` |
| 400 | Format wrong | `["Enter a valid 10-digit Nigerian bank account number"]` / `["Choose a valid bank from the list"]` |
| 503 | Provider down | `"Bank account verification is temporarily unavailable."` |
| 403 | Feature off / not verified | as above |

**Integration notes**
- Call it automatically once 10 digits are entered and a bank is picked. Show `accountName` and require the user to tick "This is my account".

---

### 8.7 Withdraw naira to a bank

**Endpoint:** `POST /v1/withdrawals/ngn` · **Auth:** **Bearer** · **KYC:** **TIER_1** · **Success:** `201`

**What it does**
Sends naira from the user's balance to a Nigerian bank account. **This moves money.** The amount plus fee is held immediately, and the bank transfer completes in the background.

**Request**

| Header | Value |
| --- | --- |
| `Idempotency-Key` | **Required** |

| Field | Type | Required | Rules | Example |
| --- | --- | --- | --- | --- |
| `amount` | string | ✅ | Positive decimal (naira that reaches the bank) | `"50000"` |
| `savedBankAccountId` | string | ✅ | From 8.8 (since 15 Oct 2026) | `"b81d…"` |

> Sending `accountNumber` or `bankCode` (the old body) answers `400 "Choose a saved bank account"`. The account's name is looked up with the bank again at payout time.

```http
POST /v1/withdrawals/ngn
Authorization: Bearer eyJhbGciOi…
Idempotency-Key: 1f7e3a9c-4b2d-4c8e-a6f1-8d0b5c3e2a71
Content-Type: application/json

{ "amount": "50000", "savedBankAccountId": "b81d4f2a-6c3e-4a9b-8d1f-5e0c7a2b9d36" }
```

**Response** `201`
```json
{
  "transactionId": "f5c3a1d9-…",
  "status": "PROCESSING",
  "asset": "ngn",
  "amount": "50000.00",
  "feeNgn": "100.00",
  "totalDebited": "50100.00",
  "bankName": "Access Bank",
  "accountNumberLast4": "6789"
}
```

| Field | Type | Description |
| --- | --- | --- |
| `transactionId` | string | Poll with 7.4 |
| `status` | string | `PROCESSING` or `RECONCILING`. Later `COMPLETED` / `FAILED`. |
| `amount` | string | Reaches the bank |
| `feeNgn` | string | **Missing when `RECONCILING`** |
| `totalDebited` | string | **Missing when `RECONCILING`** |
| `bankName`, `accountNumberLast4` | string | Destination |

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 403 | Naira withdrawals switched off | `"Naira withdrawals are temporarily unavailable."` |
| 403 | Withdrawals paused | `"Withdrawals are temporarily paused."` |
| 400 | Over limit | The same text as 8.4 `limit.reason` |
| 400 | Bank not supported | `"Choose a supported Nigerian bank"` |
| 400 | Not enough balance (amount + fee) | `"Insufficient NGN balance: need 50100, have 20000"` |
| 400 | Provider refused | `"<reason>. Nothing was deducted from your balance."` |
| 500 | Account details invalid at submit (backend bug) | Generic. **Always run 8.6 first.** |

**Integration notes**
- Flow: 8.4 (fee & limits) → 8.5 (bank) → 8.6 (confirm name) → 8.7.
- Pushes: `withdrawal.submitted`, then `withdrawal.sent` or `withdrawal.rejected`.

---

### 8.8 Saved bank accounts

Withdrawals go only to a saved account (since 15 Oct 2026). A customer may keep up to the number an admin sets (default 5).

| Endpoint | What it does |
| --- | --- |
| `GET /v1/me/bank-accounts` | `{ max, items: [...] }`, newest first. |
| `POST /v1/me/bank-accounts` | Save one. **Needs the password.** Level rule: NGN_WITHDRAW. Rate limit: 5 an hour. |
| `DELETE /v1/me/bank-accounts/:id` | Remove one (no password). `{ "removed": true }` |

**Request** (POST)

| Field | Type | Required | Rules | Example |
| --- | --- | --- | --- | --- |
| `bankCode` | string | ✅ | From 8.5 | `"000013"` |
| `accountNumber` | string | ✅ | Exactly 10 digits | `"0123451234"` |
| `nickname` | string | — | Max 40 | `"Salary"` |
| `password` | string | ✅ | The customer's password. Never stored. | |

**Response** `201` (one item; `GET` returns `{ "max": 5, "items": [ ... ] }`)
```json
{
  "id": "b81d4f2a-6c3e-4a9b-8d1f-5e0c7a2b9d36",
  "bankCode": "000013",
  "bankName": "GTBank",
  "accountNumberMasked": "******1234",
  "accountName": "ADA OKAFOR",
  "nickname": "Salary",
  "usableFrom": "2026-10-15T10:00:00.000Z",
  "usableNow": true
}
```

- The account name is the one the **bank** returns. There is no name-match rule.
- The full number is never sent back after saving; show `accountNumberMasked`.
- `usableNow: false` = still in the admin's "after new address/bank" wait; show "usable from" `usableFrom`.
- Every save emails the customer ("A new withdrawal destination was added").

**Errors**

| Case | Status | `message` |
| --- | --- | --- |
| Wrong password (counts towards the sign-in lockout) | 401 | Incorrect password |
| Account locked after too many wrong passwords | 403 | Too many failed attempts. Try again after … |
| At the limit | 400 | You can save up to 5 bank accounts. Remove one to add another. |
| Already saved | 400 | This account is already saved. |
| Bank not in the list | 400 | Choose a supported Nigerian bank |
| Bank cannot find the account | 400 | Unable to verify those bank details. Check the account and bank. |
| Not yours / removed (DELETE, or 8.7) | 404 | Saved account not found |
| Still in its wait (8.7) | 403 | `code: "DESTINATION_COOLING_OFF"`, `until`, "This account can be used from 14:00 on 16 October." |

### 8.9 Saved crypto addresses

The same, for crypto (default limit 10). `GET/POST /v1/me/crypto-addresses`, `DELETE /v1/me/crypto-addresses/:id`. Level rule for saving: CRYPTO_WITHDRAW.

| Field | Type | Required | Rules | Example |
| --- | --- | --- | --- | --- |
| `asset` | string | ✅ | Coin code | `"usdt"` |
| `network` | string | ✅ | Network id with withdrawals on (5.2) | `"trc20"` |
| `address` | string | ✅ | Checked against the network's address format; max 200 | `"TQrY8tryqsYVCYS3MFbtffiPp2ccyn4STm"` |
| `destinationTag` | string | only if the network `requiresTag` | Max 64 | `"104927"` |
| `nickname` | string | — | Max 40 | `"Ledger"` |
| `password` | string | ✅ | Never stored | |

Response item: `{ id, assetCode, networkId, networkLabel, address, destinationTag, nickname, usableFrom, usableNow }`. Errors as 8.8, with "This address is already saved.", "You can save up to 10 crypto addresses…", "That does not look like a valid <network> address" and "Saved address not found".

## 9. Gift cards

Users sell gift cards (Amazon, Steam…) for naira. **A person reviews each card**, so no money is paid at submission. The rate shown at submission is locked in.

### 9.1 Gift-card catalogue

**Endpoint:** `GET /v1/giftcards/catalogue` · **Auth:** none · **KYC:** none · **Success:** `200`

**What it does**
Returns every card the app can buy from users: **categories → brands → card types**, with each type's currency, accepted value range, and naira rate. Only active items are included.

**Request**
```http
GET /v1/giftcards/catalogue
```

**Response** `200`
```json
[
  {
    "id": "2a6c9e1f-…",
    "name": "Shopping",
    "brands": [
      {
        "id": "8b3d7f2a-…",
        "name": "Amazon",
        "imageUrl": "https://api.example.com/v1/giftcards/brands/8b3d7f2a-…/image?v=1727860000000",
        "types": [
          {
            "id": "c4e8a1b9-…",
            "name": "E-code",
            "currency": "USD",
            "currencySymbol": "$",
            "currencySymbolFirst": true,
            "minAmount": "25.00",
            "maxAmount": "500.00",
            "rateNgn": "1250.00"
          }
        ]
      }
    ]
  }
]
```

| Field | Type | Description |
| --- | --- | --- |
| `id`, `name` | string | Category |
| `brands[].id`, `.name` | string | Brand |
| `brands[].imageUrl` | string \| null | Absolute logo URL (public, cache forever). `null` = show the brand name instead. |
| `types[].id` | string | Send as `typeId` in 9.3 |
| `types[].name` | string | e.g. "E-code", "Physical" |
| `types[].currency` | string | Card currency (USD, GBP, EUR…) |
| `types[].currencySymbol` | string | e.g. `$` |
| `types[].currencySymbolFirst` | boolean | `true` → "$100"; `false` → "100 kr" |
| `types[].minAmount`, `maxAmount` | string | Allowed card value range (in the card currency) |
| `types[].rateNgn` | string | **Naira paid per 1 unit** of the card currency |

**Integration notes**
- Expected payout = `faceValue × rateNgn`. Show it live as the user types.
- An empty array means no cards are set up yet.

---

### 9.2 Brand logo

**Endpoint:** `GET /v1/giftcards/brands/{id}/image` · **Auth:** none · **KYC:** none · **Success:** `200`

**What it does**
Returns the brand's logo image (JPEG/PNG/WebP bytes). Usually you just load `imageUrl` from 9.1, which points here.

**Errors**: `404 "No image"` when no logo is uploaded.

---

### 9.3 Sell a gift card

**Endpoint:** `POST /v1/giftcards/trades` · **Auth:** **Bearer** · **KYC:** **TIER_1 (Basic)** · **Success:** `201`

> **Since 15 Oct 2026:** who may sell gift cards, and how much a day, is an admin rule (3.3). Not allowed: `403` `code: "NOT_ALLOWED_AT_LEVEL"` (§0.6). Over the daily limit: `400` with the reason in `message`.

**What it does**
Submits a card for review, with photos and/or the card code. The rate is locked at this moment. No money moves until an admin approves it (fully or partly) or rejects it. The card code is encrypted and **never shown again**, not even to the user.

**Request**

| Field | Type | Required | Rules | Example |
| --- | --- | --- | --- | --- |
| `typeId` | string (UUID) | ✅ | `types[].id` from 9.1 | `"c4e8a1b9-…"` |
| `faceValue` | string | ✅ | Positive decimal within the type's `minAmount`–`maxAmount` | `"100"` |
| `code` | string | one of `code`/`images` | Card code, max 200 | `"AMZN-XXXX-YYYY"` |
| `images` | string[] | one of `code`/`images` | Up to **5** data URLs `data:image/jpeg;base64,…`. JPEG, PNG or WebP. | see below |

> **Photo size (changed 19 Oct 2026):** each photo up to **5 MB**, and the whole request up to **36 MB** (5 photos as base64). Still resize on the phone (longest edge **~1280 px**, JPEG quality **~70**, Appendix D) so the upload is quick on mobile data. Too big returns `413`.
>
> **Retrying is safe:** the same photos, card and value sent again within 10 minutes return the first trade instead of making a second one.

```http
POST /v1/giftcards/trades
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json

{
  "typeId": "c4e8a1b9-…",
  "faceValue": "100",
  "images": ["data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ…"]
}
```

**Response** `201`: the new card trade (same object as one item of 9.4):
```json
{
  "id": "6d1f0a9c-2b7e-4f3d-a8c5-9e0b1d2c3f47",
  "brand": "Amazon",
  "type": "E-code",
  "currency": "USD",
  "currencySymbol": "$",
  "currencySymbolFirst": true,
  "faceValue": "100.00",
  "rateNgn": "1250.00",
  "expectedNgn": "125000.00",
  "status": "PENDING",
  "creditedNgn": null,
  "approvedValue": null,
  "reason": null,
  "images": ["/v1/giftcards/trades/6d1f0a9c-…/images/0e9a…"],
  "createdAt": "2026-10-02T09:00:00.000Z",
  "reviewedAt": null
}
```
(Fields explained in 9.4.)

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 400 | Card type inactive / unknown | `"That card is not available to trade right now"` |
| 400 | Bad value | `"Enter the value of the card"` |
| 400 | Outside the range | `"Amazon E-code takes between 25.00 and 500.00 USD"` |
| 400 | No code and no photo | `"Add a photo of the card, or type its code"` |
| 400 | Codes not accepted right now | `"Card codes cannot be accepted right now. Send a photo instead, or try again shortly."` |
| 400 | Photo problems | `"That image is empty"` / `"Each image must be 5 MB or smaller"` / `"Images must be JPEG, PNG or WebP"` |
| 400 | More than 5 photos / bad `typeId` | validation array |
| 413 | Body over 36 MB | `"This request is too large. A card can have up to 5 photos of 5 MB each."` |
| 503 | File storage down | `"File storage is unavailable right now. Please try again shortly."`: let the user try again |

**Integration notes**
- Show upload progress; this is a large request.
- Pushes: `deposit.detected` ("Card submitted"), then `deposit.credited` (paid) or `deposit.failed` (rejected). See Appendix A.

---

### 9.4 My gift-card trades

**Endpoint:** `GET /v1/giftcards/trades` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Lists the user's last 100 card submissions, newest first, with their review result.

**Request**
```http
GET /v1/giftcards/trades
Authorization: Bearer eyJhbGciOi…
```

**Response** `200`
```json
[
  {
    "id": "6d1f0a9c-2b7e-4f3d-a8c5-9e0b1d2c3f47",
    "brand": "Amazon",
    "type": "E-code",
    "currency": "USD",
    "currencySymbol": "$",
    "currencySymbolFirst": true,
    "faceValue": "100.00",
    "rateNgn": "1250.00",
    "expectedNgn": "125000.00",
    "status": "PARTIALLY_APPROVED",
    "creditedNgn": "75000.00",
    "approvedValue": "60.00",
    "reason": "The card had $60 remaining.",
    "images": ["/v1/giftcards/trades/6d1f0a9c-…/images/0e9a…"],
    "createdAt": "2026-10-02T09:00:00.000Z",
    "reviewedAt": "2026-10-02T09:20:00.000Z"
  }
]
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Card trade id |
| `brand`, `type` | string | Names |
| `currency`, `currencySymbol`, `currencySymbolFirst` | string / boolean | For formatting `faceValue` |
| `faceValue` | string | Value the user entered |
| `rateNgn` | string | Rate locked at submission |
| `expectedNgn` | string | `faceValue × rateNgn`: what the user was shown |
| `status` | string | `PENDING` / `APPROVED` / `PARTIALLY_APPROVED` / `REJECTED` |
| `creditedNgn` | string \| null | Naira actually paid. `null` until paid, and stays `null` on rejection. |
| `approvedValue` | string \| null | The card value accepted (less than `faceValue` on a partial approval) |
| `reason` | string \| null | Reviewer's explanation. **Show it verbatim.** |
| `images` | string[] | **Relative, private** photo paths: host + path, **with** the `Authorization` header (9.6) |
| `createdAt`, `reviewedAt` | string / null | |

---

### 9.5 One gift-card trade

**Endpoint:** `GET /v1/giftcards/trades/{id}` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Returns one of the user's card trades (same object as 9.4).

**Request**
```http
GET /v1/giftcards/trades/6d1f0a9c-2b7e-4f3d-a8c5-9e0b1d2c3f47
Authorization: Bearer eyJhbGciOi…
```

**Response** `200`: one object, as in 9.4.

**Errors**: `404 "No such card"`.

---

### 9.6 Gift-card photo

**Endpoint:** `GET /v1/giftcards/trades/{id}/images/{imageId}` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Returns one of the photos the user uploaded (image bytes). Only the owner can fetch it.

**Request**
```http
GET /v1/giftcards/trades/6d1f0a9c-…/images/0e9a…
Authorization: Bearer eyJhbGciOi…
```

**Response** `200`: image bytes (`image/jpeg`, `image/png` or `image/webp`).

**Errors**: `404 "No image"`.

**Integration notes**
- `Image.network(host + path, headers: {'Authorization': 'Bearer $token'})`.

---

## 10. Referrals

### 10.1 Check a referral code

**Endpoint:** `GET /v1/referrals/code/{code}` · **Auth:** none · **KYC:** none · **Success:** `200`

**What it does**
Checks a referral code on the sign-up screen. Returns whose code it is (first name only) and the bonus the new user would get.

**Request**

| Param | In | Type | Required | Notes |
| --- | --- | --- | --- | --- |
| `code` | path | string | ✅ | Case-insensitive |

```http
GET /v1/referrals/code/ADA4K9
```

**Response** `200`
```json
{ "valid": true, "referrerFirstName": "Ada", "bonusNgn": "1000.00" }
```
Unknown code (real response):
```json
{ "valid": false, "referrerFirstName": null, "bonusNgn": "0.00" }
```

| Field | Type | Description |
| --- | --- | --- |
| `valid` | boolean | Code exists **and** the referral programme is on |
| `referrerFirstName` | string \| null | For "Invited by Ada" |
| `bonusNgn` | string | Naira bonus for the new user |

**Integration notes**
- Referral links look like `https://<website>/r/<CODE>`. On a deep link, take `<CODE>`, check it here, and send it as `referralCode` in 2.1.

---

### 10.2 Referral dashboard

**Endpoint:** `GET /v1/referrals/me` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Everything for the "Invite friends" screen: the user's code and share link, the current offer, what they've earned, what's still pending, and each person they invited. **Opening it also pays out any rewards that have just become due.**

**Request**
```http
GET /v1/referrals/me
Authorization: Bearer eyJhbGciOi…
```

**Response** `200`
```json
{
  "code": "ADA4K9",
  "link": "https://davochain.com/r/ADA4K9",
  "username": null,
  "canSetUsername": true,
  "offer": {
    "isEnabled": true,
    "headline": "Invite friends, earn naira",
    "terms": null,
    "theyGetNgn": "1000.00",
    "youGetNgn": "2000.00",
    "unlockTier": "TIER_1",
    "tradeVolumeNgn": "50000.00"
  },
  "totals": { "earnedNgn": "4000.00", "pendingNgn": "2000.00", "referrals": 3, "completed": 2 },
  "signupBonus": {
    "amountNgn": "1000.00",
    "blockedReason": "Complete TIER 1 verification and trade ₦50000.00 to unlock — ₦0.00 so far"
  },
  "referrals": [
    { "name": "Chidi Eze", "joinedAt": "2026-09-30T12:00:00.000Z", "status": "pending", "amountNgn": "2000.00", "note": "Waiting for them to reach TIER 1" }
  ]
}
```

| Field | Type | Description |
| --- | --- | --- |
| `code` | string | The user's referral code (their username if they set one) |
| `link` | string | Ready-to-share link |
| `username` | string \| null | Chosen username, if any |
| `canSetUsername` | boolean | `true` = show "Choose a custom code" (allowed once) |
| `offer.isEnabled` | boolean | Programme on/off |
| `offer.headline`, `offer.terms` | string / null | Text to show |
| `offer.theyGetNgn` | string | What an invited friend gets |
| `offer.youGetNgn` | string | What this user gets per friend |
| `offer.unlockTier` | string | Tier the friend must reach |
| `offer.tradeVolumeNgn` | string | Naira the **friend** must trade to unlock *their own* bonus (`"0.00"` = none) |
| `totals.earnedNgn` | string | Already paid into the naira balance |
| `totals.pendingNgn` | string | **Promised, not paid yet.** Never add it to the balance. |
| `totals.referrals`, `totals.completed` | number | Counts |
| `signupBonus` | object \| null | This user's own signup bonus, if they joined with a code: `amountNgn` + `blockedReason` (what's left to do) |
| `referrals[].name` | string | Invited person |
| `referrals[].joinedAt` | string | |
| `referrals[].status` | string | `"pending"` or `"completed"` (lowercase) |
| `referrals[].amountNgn` | string | Reward for this person |
| `referrals[].note` | string \| null | What it's waiting for (`null` once paid) |

**Integration notes**
- Paid rewards show up in 6.3 deposit history as naira deposits.
- Label `pendingNgn` and `signupBonus` clearly as "pending".

---

### 10.3 Set a custom referral username

**Endpoint:** `PUT /v1/referrals/username` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Replaces the user's generated code with one they choose. **It can be done only once and never changed**, because shared links must keep pointing to the same person.

**Request**

| Field | Type | Required | Rules | Example |
| --- | --- | --- | --- | --- |
| `username` | string | ✅ | 3–7 characters, letters and numbers only, at least one letter. Saved in **UPPERCASE**. Some words are reserved (ADMIN, API, APP…). | `"ada"` |

```http
PUT /v1/referrals/username
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json

{ "username": "ada" }
```

**Response** `200`
```json
{ "code": "ADA" }
```

| Field | Type | Description |
| --- | --- | --- |
| `code` | string | The new referral code (uppercase) |

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 400 | Too short | `"A username needs at least 3 characters."` |
| 400 | Too long | `"A username can be at most 7 characters."` |
| 400 | Bad characters | `"Letters and numbers only — no spaces, accents or punctuation."` |
| 400 | No letter | `"A username needs at least one letter."` |
| 400 | Reserved | `"That one is reserved. Try another."` |
| 409 | Taken | `"That username is taken. Try another."` |
| 409 | Already set | `"Your username is already ADA and cannot be changed — links you have shared point at it."` |

**Integration notes**
- Validate the rules as the user types, and **ask for confirmation** ("This can't be changed later").

---

## 11. Notifications

### 11.1 Notification feed

**Endpoint:** `GET /v1/notifications?limit={n}` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Returns the in-app notification list (newest first) and the number of unread items. Every push notification is also stored here.

**Request**

| Param | In | Type | Required | Rules |
| --- | --- | --- | --- | --- |
| `limit` | query | integer | ❌ | Default 50, max 100 |

```http
GET /v1/notifications?limit=50
Authorization: Bearer eyJhbGciOi…
```

**Response** `200`
```json
{
  "unread": 2,
  "items": [
    {
      "id": "0f3e7a2d-…",
      "type": "trade.completed",
      "title": "Bought 0.00067342 BTC",
      "body": "Rate: ₦1485.00 per $1",
      "transactionId": "a71c9e3b-5d2f-4a1e-8c6b-2f9d0e7a3b14",
      "readAt": null,
      "createdAt": "2026-10-02T10:00:06.000Z"
    }
  ]
}
```

| Field | Type | Description |
| --- | --- | --- |
| `unread` | number | Badge count |
| `items[].id` | string | Notification id (for 11.2) |
| `items[].type` | string | What happened (Appendix A) |
| `items[].title`, `.body` | string | Text to show |
| `items[].transactionId` | string \| null | Open that transaction (7.4) |
| `items[].readAt` | string \| null | `null` = unread |
| `items[].createdAt` | string | |

---

### 11.2 Mark notifications as read

**Endpoint:** `POST /v1/notifications/read` · **Auth:** **Bearer** · **KYC:** none · **Success:** `201`

**What it does**
Marks some notifications, or all of them, as read.

**Request**

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `ids` | string[] | ❌ | Notification ids. **Leave the field out to mark ALL as read.** |

```http
POST /v1/notifications/read
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json

{ "ids": ["0f3e7a2d-…"] }
```
Mark all: send `{}`.

**Response** `201`
```json
{ "updated": 1 }
```

| Field | Type | Description |
| --- | --- | --- |
| `updated` | number | How many were changed |

---

## 12. Devices (push tokens)

### 12.1 Register this device for push

**Endpoint:** `POST /v1/devices` · **Auth:** **Bearer** · **KYC:** none · **Success:** `201`

**What it does**
Saves this phone's Firebase (FCM) token so the user receives push notifications here. It's safe to call repeatedly. If the same token was registered by another user on this phone, it moves to the current user.

**Request**

| Field | Type | Required | Rules | Example |
| --- | --- | --- | --- | --- |
| `token` | string | ✅ | FCM registration token, max 500 | `"fXk2…:APA91b…"` |
| `platform` | string | ✅ | `"ANDROID"` or `"IOS"` | `"ANDROID"` |
| `appVersion` | string | ❌ | Max 40 | `"1.0.3+12"` |

```http
POST /v1/devices
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json

{ "token": "fXk2…:APA91b…", "platform": "ANDROID", "appVersion": "1.0.3+12" }
```

**Response** `201`
```json
{ "id": "d7a1c3e5-…", "platform": "ANDROID", "createdAt": "2026-10-02T09:00:00.000Z" }
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Device record id |
| `platform` | string | |
| `createdAt` | string | |

**Errors**

| Status | When | `message` |
| --- | --- | --- |
| 400 | Bad platform | `["platform must be one of the following values: ANDROID, IOS, WEB"]` |

**Integration notes**
- Call it after **login / register**, and in `FirebaseMessaging.instance.onTokenRefresh`.

---

### 12.2 Unregister this device

**Endpoint:** `DELETE /v1/devices` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Stops push notifications to this phone for this user. **Call it before logging out**, so the next person using the phone doesn't get this user's alerts.

**Request** (this DELETE **has a JSON body**; Dio supports `data:` on delete)

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `token` | string | ✅ | Same FCM token as 12.1, max 500 |

```http
DELETE /v1/devices
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json

{ "token": "fXk2…:APA91b…" }
```

**Response** `200`
```json
{ "unregistered": true }
```

---

### 12.3 List my devices

**Endpoint:** `GET /v1/devices` · **Auth:** **Bearer** · **KYC:** none · **Success:** `200`

**What it does**
Lists the devices registered for push for this user (for a "my devices" settings screen).

**Request**
```http
GET /v1/devices
Authorization: Bearer eyJhbGciOi…
```

**Response** `200`
```json
[
  { "id": "d7a1c3e5-…", "platform": "ANDROID", "appVersion": "1.0.3+12", "lastSeenAt": "2026-10-02T09:00:00.000Z", "disabledAt": null }
]
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | |
| `platform` | string | `ANDROID` / `IOS` / `WEB` |
| `appVersion` | string \| null | |
| `lastSeenAt` | string | Last registration |
| `disabledAt` | string \| null | Set when Firebase reported the token dead |

---

## 13. Site settings & content

### 13.1 Site settings

**Endpoint:** `GET /v1/site` · **Auth:** none · **KYC:** none · **Success:** `200`

**What it does**
Returns app-wide settings set by admins: **maintenance mode**, the **latest app versions** (for update prompts), support contacts, social links and the logo. Call it on app start.

**Request**
```http
GET /v1/site
```

**Response** `200` (real response from a fresh install)
```json
{
  "companyName": "Davochain",
  "supportEmail": "support@davochain.com",
  "phone": null,
  "address": null,
  "apps": { "iosVersion": null, "androidVersion": null, "iosStoreUrl": null, "androidStoreUrl": null },
  "maintenance": { "active": false, "message": null },
  "socials": [],
  "logoUrl": null
}
```
With values filled in:
```json
{
  "companyName": "Davochain",
  "supportEmail": "support@davochain.com",
  "phone": "+234 916 001 2046",
  "address": "Lagos, Nigeria",
  "apps": { "iosVersion": "1.2.0", "androidVersion": "1.2.0", "iosStoreUrl": "https://apps.apple.com/…", "androidStoreUrl": "https://play.google.com/…" },
  "maintenance": { "active": true, "message": "We're upgrading. Back by 2pm." },
  "socials": [
    { "label": "X", "url": "https://x.com/davochain", "iconUrl": "https://api.example.com/v1/site/social/3a…/icon?v=1727860000000", "glyph": "&#120143;" }
  ],
  "logoUrl": "/v1/site/logo?v=1727860000000"
}
```

| Field | Type | Description |
| --- | --- | --- |
| `companyName`, `supportEmail` | string | For the support/contact screen |
| `phone`, `address` | string \| null | |
| `apps.iosVersion`, `apps.androidVersion` | string \| null | **Latest published version.** If the installed version is lower, show an update prompt. |
| `apps.iosStoreUrl`, `apps.androidStoreUrl` | string \| null | Store links for the update button |
| `maintenance.active` | boolean | **`true` = show a full-screen "under maintenance" page**, with `message` |
| `maintenance.message` | string \| null | |
| `socials[].label`, `.url` | string | Social network name and link |
| `socials[].iconUrl` | string \| null | Absolute icon URL. If `null`, show `label`. |
| `socials[].glyph` | string | Fallback short text. **May be an HTML entity** (e.g. `&#120143;`); decode it or ignore it. |
| `logoUrl` | string \| null | **Relative** path, so prefix the host |

**Integration notes**
- **The API doesn't block requests during maintenance**; the app must check `maintenance.active` and stop itself.

---

### 13.2 Logo

**Endpoint:** `GET /v1/site/logo?v={version}` · **Auth:** none · **Success:** `200`

**What it does**
Returns the company logo image. Use `logoUrl` from 13.1; the `v` value changes when the logo changes, so you can cache forever.
**Errors**: `404 "No logo set"`.

### 13.3 Social icon

**Endpoint:** `GET /v1/site/social/{id}/icon?v={version}` · **Auth:** none · **Success:** `200`

**What it does**
Returns one social network's icon. Use `socials[].iconUrl` from 13.1.
**Errors**: `404 "No icon set"`.

---

### 13.4 List content pages

**Endpoint:** `GET /v1/content/pages` · **Auth:** none · **KYC:** none · **Success:** `200`

**What it does**
Lists the published information pages (About us, Terms, Privacy, plus any an admin adds), for a "Legal" or "About" menu.

**Request**
```http
GET /v1/content/pages
```

**Response** `200` (real response)
```json
[
  { "slug": "about-us",             "title": "About us",             "excerpt": "Who we are and what we do.",               "updatedAt": "2026-09-30T08:35:12.450Z" },
  { "slug": "terms-and-conditions", "title": "Terms and conditions", "excerpt": "The agreement between you and us.",        "updatedAt": "2026-09-30T08:35:12.474Z" },
  { "slug": "privacy-policy",       "title": "Privacy policy",       "excerpt": "What we collect, and what we do with it.", "updatedAt": "2026-09-30T08:35:12.512Z" }
]
```

| Field | Type | Description |
| --- | --- | --- |
| `slug` | string | Use it in 13.5 |
| `title` | string | Menu label |
| `excerpt` | string | One-line summary |
| `updatedAt` | string | "Last updated" |

**Integration notes**
- `about-us`, `terms-and-conditions` and `privacy-policy` always exist. Link Sign-up's "I agree to the Terms" to `terms-and-conditions`.

---

### 13.5 Get one content page

**Endpoint:** `GET /v1/content/pages/{slug}` · **Auth:** none · **KYC:** none · **Success:** `200`

**What it does**
Returns the full content of one page as **HTML** (for rich display) and **plain text** (fallback).

**Request**
```http
GET /v1/content/pages/terms-and-conditions
```

**Response** `200`
```json
{
  "slug": "terms-and-conditions",
  "title": "Terms and conditions",
  "excerpt": "The agreement between you and us.",
  "html": "<h2>1. Introduction</h2><p>These terms…</p>",
  "text": "1. Introduction\nThese terms…",
  "updatedAt": "2026-09-30T08:35:12.474Z"
}
```

| Field | Type | Description |
| --- | --- | --- |
| `slug`, `title`, `excerpt` | string | |
| `html` | string | Page body as HTML (already cleaned by the server). Render with e.g. `flutter_widget_from_html`. |
| `text` | string | Same content as plain text |
| `updatedAt` | string | |

**Errors**: `404 "Page not found"` (unknown or unpublished).

---

### 13.6 FAQs

**Endpoint:** `GET /v1/content/faqs` · **Auth:** none · **KYC:** none · **Success:** `200`

**What it does**
Returns published FAQs grouped by category, for a help screen.

**Request**
```http
GET /v1/content/faqs
```

**Response** `200`
```json
{
  "total": 1,
  "groups": [
    {
      "category": "Deposits",
      "items": [
        { "id": "f1a2…", "question": "How long do deposits take?", "answerHtml": "<p>Usually a few minutes…</p>", "answerText": "Usually a few minutes…" }
      ]
    }
  ]
}
```

| Field | Type | Description |
| --- | --- | --- |
| `total` | number | Number of FAQs |
| `groups[].category` | string | Section heading (`"General"` if none set) |
| `groups[].items[].id` | string | |
| `.question` | string | |
| `.answerHtml` | string | Answer as HTML |
| `.answerText` | string | Answer as plain text |

---

# Part 2: Appendices

## Appendix A: Push notifications

Push uses **Firebase Cloud Messaging** and is **off until the backend adds Firebase credentials** (Appendix E). Every push is also saved in the feed (11.1), so the feed is the source of truth.

**What a push looks like**
```jsonc
{
  "notification": { "title": "Bought 0.00067342 BTC", "body": "Rate: ₦1485.00 per $1" },
  "data": {
    "type": "trade.completed",   // always present
    "notificationId": "0f3e…",   // always present: the feed item id
    "transactionId": "a71c…",    // present when it's about a transaction
    "broadcastId": "b1…"         // only on admin announcements
  },
  "android": { "priority": "high", "notification": { "channelId": "davochain" } },
  "apns": { "payload": { "aps": { "sound": "default" } } }
}
```

**Setup**
- **Android:** create a notification channel with id **`davochain`** when the app starts.
- **iOS:** the backend must upload the APNs key to Firebase, or iOS gets nothing.

**Types and where to send the user on tap**

| `data.type` | Sent when | `transactionId`? | On tap open |
| --- | --- | --- | --- |
| `address.ready` | Deposit address finished generating | no | Deposit screen |
| `deposit.detected` | Crypto deposit seen, waiting for confirmations. **Also: gift card submitted.** | crypto: yes / gift card: no | Activity / gift-card history |
| `deposit.credited` | Deposit credited, held deposit released, referral reward paid. **Also: gift card paid** (`transactionId` type `GIFT_CARD`). | yes | Transaction (7.4); for `GIFT_CARD`, gift-card history |
| `deposit.on_hold` | Naira deposit held for review | yes | Activity |
| `deposit.failed` | Deposit rejected. **Also: gift card rejected.** | crypto: yes / gift card: no | Activity / gift-card history |
| `trade.completed` | Buy, sell or swap finished | yes | Trade detail |
| `trade.failed` | Trade failed, nothing deducted | yes | Trade detail |
| `withdrawal.submitted` | Withdrawal accepted | yes | Withdrawal detail |
| `withdrawal.sent` | Withdrawal completed | yes | Withdrawal detail |
| `withdrawal.rejected` | Withdrawal returned to the balance | yes | Withdrawal detail |
| `admin.broadcast.<id>` | Announcement | no (`broadcastId`) | Notification feed |

**Rules**
- Match `admin.broadcast.` as a **prefix**.
- A `deposit.*` push **without** `transactionId` is a gift-card event.
- Unknown types: just open the notification feed (new types will be added).

---

## Appendix B: Enum values

| Name | Values |
| --- | --- |
| KYC tier | `TIER_0` (signed up) · `TIER_1` (**Basic**: BVN/NIN checked) · `TIER_2` / `TIER_3` (Advanced, not available yet) |
| KYC level (4.1 `level`) | `NONE` · `BASIC` |
| Basic state (4.1 `basicState`, 4.2 `state`) | `CREATED` · `LOOKED_UP` · `APPROVED` · `IDENTITY_REVIEW` · `COMPLIANCE_REVIEW` · `REJECTED_NOT_FOUND` · `REJECTED_BY_REVIEW` · `FAILED_SYSTEM` |
| `403` codes | `ACCOUNT_SUSPENDED` · `ACCOUNT_CLOSED` · `VERIFICATION_PENDING` · `ACCOUNT_UNDER_REVIEW` |
| KYC status | `NOT_STARTED` · `PENDING` · `APPROVED` · `REJECTED` · `EXPIRED` (not used yet) |
| User status | `ACTIVE` · `SUSPENDED` · `CLOSED` |
| Transaction status | `PENDING` · `PROCESSING` · `ON_HOLD` · `COMPLETED` · `FAILED` · `RECONCILING` |
| Trade type (7.3) | `BUY` · `SELL` · `SWAP` |
| Transaction type (7.4) | `BUY` · `SELL` · `SWAP` · `DEPOSIT` · `WITHDRAWAL` · `GIFT_CARD` |
| Quote side | Request: `buy` `sell` `swap` · Response: `BUY` `SELL` `SWAP` |
| Deposit address status | `PENDING` · `ACTIVE` · `FAILED` · `DISABLED` |
| Gift-card trade status | `PENDING` · `APPROVED` · `PARTIALLY_APPROVED` · `REJECTED` |
| Device platform | `ANDROID` · `IOS` · `WEB` |
| Referral row status | `pending` · `completed` (lowercase) |
| KYC document type | `BVN` · `NIN` · `PASSPORT` · `DRIVERS_LICENSE` · `VOTERS_CARD` · `SELFIE` · `PROOF_OF_ADDRESS` |

Parse enums safely: map unknown values to an "unknown" case instead of crashing.

---

## Appendix C: Screen flows

| Screen | Calls, in order |
| --- | --- |
| **App start** | 13.1 (maintenance? update?) → tokens saved? → 3.1 → 3.2, 11.1 (badge) |
| **Sign up** | (10.1 if code) → 2.1 → 12.1 → KYC |
| **Sign in** | 2.2 → 12.1 → 3.1 |
| **Verify (KYC)** | 4.1 → 4.2 → (wait) 4.1 shows `APPROVED` → "sign in again" → 2.2 |
| **Home / wallet** | 3.2, 5.1 |
| **Deposit crypto** | 5.2 (`deposit`) → 6.1 → poll 6.1 until `usable` → show address/QR/tag |
| **Buy / sell** | 7.1 (debounced, 12 s countdown) → 7.2 (new Idempotency-Key) → 3.2 |
| **Swap** | 7.1 (`swap`) → 7.2 → poll 7.4 while `PROCESSING` |
| **Withdraw crypto** | 5.2 (`withdraw`) → 8.1 → 8.2 → poll 7.4 / push |
| **Withdraw naira** | 8.4 (`payoutAvailable`?) → 8.5 → 8.6 → 8.7 |
| **Activity** | 7.3, 6.3, 8.3 (merge and sort by `createdAt` in the app) |
| **Sell gift card** | 9.1 → (resize photos) → 9.3 → 9.4 |
| **Referrals** | 10.2 → (10.3 once) |
| **Notifications** | 11.1 → 11.2 |
| **Legal / help** | 13.4 → 13.5, 13.6 |
| **Settings** | 2.5 change password, 12.3 devices, 13.1 support details |
| **Sign out** | 12.2 → 2.4 → clear secure storage |

---

## Appendix D: Dart starter code

Packages: `dio`, `flutter_secure_storage`, `decimal`, `uuid`, `firebase_messaging`, `flutter_image_compress`, `flutter_widget_from_html`.

### D.1 Money

```dart
import 'package:decimal/decimal.dart';

// Reading: never double.parse
final available = Decimal.parse(json['available'] as String);

// Sending: Decimal.toString() gives a plain number string ("0.00067342")
final body = {'side': 'buy', 'fromAsset': 'ngn', 'toAsset': 'btc', 'amount': amount.toString()};

// Showing: cut DOWN to the coin's displayScale (5.1); naira = 2
String show(Decimal v, int scale) => v.floor(scale: scale).toStringAsFixed(scale);
```

### D.2 API client with safe token refresh

```dart
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class TokenStore {
  final _s = const FlutterSecureStorage();
  Future<String?> access() => _s.read(key: 'at');
  Future<String?> refresh() => _s.read(key: 'rt');
  Future<void> save(String at, String rt) async {
    await _s.write(key: 'at', value: at);
    await _s.write(key: 'rt', value: rt);
  }
  Future<void> clear() => _s.deleteAll();
}

class Api {
  Api(this.host, this.tokens) {
    dio = Dio(BaseOptions(baseUrl: host, contentType: 'application/json'));
    dio.interceptors.add(InterceptorsWrapper(
      onRequest: (o, h) async {
        final t = await tokens.access();
        if (t != null) o.headers['Authorization'] = 'Bearer $t';
        h.next(o);
      },
      onError: (e, h) async {
        final is401 = e.response?.statusCode == 401;
        final retried = e.requestOptions.extra['retried'] == true;
        if (!is401 || retried || _noRefresh.contains(e.requestOptions.path)) return h.next(e);
        try {
          final fresh = await _refreshOnce();               // all 401s share ONE refresh
          final o = e.requestOptions
            ..headers['Authorization'] = 'Bearer $fresh'
            ..extra['retried'] = true;
          h.resolve(await dio.fetch(o));
        } catch (_) {
          await tokens.clear();
          onSignedOut();                                    // navigate to sign-in
          h.next(e);
        }
      },
    ));
  }

  final String host;                 // e.g. http://10.0.2.2:3000 (no /v1)
  final TokenStore tokens;
  late final Dio dio;
  void Function() onSignedOut = () {};
  Future<String>? _refreshing;

  Future<String> _refreshOnce() =>
      _refreshing ??= _doRefresh().whenComplete(() => _refreshing = null);

  Future<String> _doRefresh() async {
    final rt = await tokens.refresh();
    if (rt == null) throw StateError('no refresh token');
    final r = await Dio(BaseOptions(baseUrl: host))          // bare Dio: skips the interceptor
        .post('/v1/auth/refresh', data: {'refreshToken': rt});
    await tokens.save(r.data['accessToken'], r.data['refreshToken']);   // save BOTH
    return r.data['accessToken'] as String;
  }

  // A 401 here means wrong credentials, not an expired token.
  static const _noRefresh = {
    '/v1/auth/login', '/v1/auth/refresh', '/v1/auth/register',
    '/v1/auth/change-password', '/v1/auth/reset/request', '/v1/auth/reset/confirm',
  };
}
```

### D.3 Reading errors

```dart
class ApiError implements Exception {
  ApiError(this.status, this.message, {this.code, this.requiredTier, this.retryAfterSeconds});
  final int status;
  final String message;
  final String? code;          // ACCOUNT_SUSPENDED / ACCOUNT_CLOSED / VERIFICATION_PENDING / ACCOUNT_UNDER_REVIEW
  final String? requiredTier;  // set on KYC 403
  final int? retryAfterSeconds; // set on 429 (0.4.1): disable the button this long

  factory ApiError.from(DioException e) {
    final s = e.response?.statusCode ?? 0;
    final d = e.response?.data;
    if (d is Map) {
      final m = d['message'];
      final text = m is List ? m.join('\n') : (m?.toString() ?? 'Something went wrong');
      final retryAfter = int.tryParse(e.response?.headers.value('retry-after') ?? '');
      return ApiError(s, text,
          code: d['code'] as String?, requiredTier: d['requiredTier'] as String?, retryAfterSeconds: retryAfter);
    }
    return ApiError(s, 'Something went wrong. Please try again.');
  }

  bool get needsKyc => status == 403 && requiredTier != null;
  bool get suspended => code == 'ACCOUNT_SUSPENDED';
  bool get closed => code == 'ACCOUNT_CLOSED';
  bool get verificationPending => code == 'VERIFICATION_PENDING'; // §0.6: show message, re-check 4.1 later
  bool get underReview => code == 'ACCOUNT_UNDER_REVIEW'; // §0.6: show message as-is, never explain
  bool get rateLimited => status == 429; // never auto-retry auth routes; wait retryAfterSeconds
}
```

### D.3a Basic verification

```dart
Future<Map<String, dynamic>> submitBasic(Dio dio, {
  required String idType, // "BVN" or "NIN"
  required String idNumber,
  required String firstName,
  String? middleName,
  required String lastName,
  required String dateOfBirth, // YYYY-MM-DD
  required String street,
  required String city,
  required String state, // from GET /v1/kyc/states
  required String lga, // from the same state
  required String stateOfOrigin,
}) async {
  // One request, no automatic retry: each call can cost a paid lookup.
  final res = await dio.post('/v1/kyc/basic', data: {
    'idType': idType,
    'idNumber': idNumber,
    'firstName': firstName,
    if (middleName != null && middleName.isNotEmpty) 'middleName': middleName,
    'lastName': lastName,
    'dateOfBirth': dateOfBirth,
    'address': {'street': street, 'city': city, 'state': state, 'lga': lga},
    'stateOfOrigin': stateOfOrigin,
    'country': 'NG',
  });
  return res.data as Map<String, dynamic>; // { state, level, message }
}
```

### D.4 Trade with Idempotency-Key and safe retry

```dart
import 'package:uuid/uuid.dart';

Future<Map<String, dynamic>> executeTrade(Api api, String quoteId) async {
  final key = const Uuid().v4();                       // ONE key for this tap
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      final r = await api.dio.post('/v1/trades',
          data: {'quoteId': quoteId},
          options: Options(headers: {'Idempotency-Key': key}));
      return r.data as Map<String, dynamic>;
    } on DioException catch (e) {
      final s = e.response?.statusCode;
      final networkProblem = e.response == null;        // timeout / no connection
      final stillRunning = s == 409 &&
          (e.response?.data?['message']?.toString().contains('still processing') ?? false);
      if (!(networkProblem || stillRunning)) throw ApiError.from(e);
      await Future.delayed(const Duration(seconds: 2));  // then retry with the SAME key
    }
  }
  throw ApiError(0, 'We could not confirm your trade. Check your activity before trying again.');
}
```

### D.5 Photo resizing (quicker uploads for gift cards and KYC documents)

```dart
import 'dart:convert';
import 'package:flutter_image_compress/flutter_image_compress.dart';

Future<String> toDataUrl(String path) async {
  final bytes = await FlutterImageCompress.compressWithFile(
    path, minWidth: 1280, minHeight: 1280, quality: 70, format: CompressFormat.jpeg,
  );
  return 'data:image/jpeg;base64,${base64Encode(bytes!)}';
}

// Before sending: make sure the whole JSON is under ~950 KB
bool fitsLimit(Map<String, dynamic> body) => utf8.encode(jsonEncode(body)).length < 950 * 1024;
```

### D.6 Quote countdown

```dart
import 'dart:async';

// Start when a quote arrives; on 0 disable Continue (never auto-requote).
Timer? _timer;
void startCountdown(Map q, void Function(int left) onTick) {
  _timer?.cancel();
  final expires = DateTime.parse(q['expiresAt'] as String);
  _timer = Timer.periodic(const Duration(milliseconds: 250), (_) {
    final left = expires.difference(DateTime.now().toUtc()).inSeconds
        .clamp(0, q['ttlSeconds'] as int);
    onTick(left);
    if (left == 0) _timer?.cancel();
  });
}
```

---

## Appendix E: Testing on the local backend

Locally the API uses a **fake ("mock") version of Quidax**, the crypto provider. No real money, no real blockchain.

**Getting a test account ready (ask the backend team):**
1. Register in the app (2.1).
2. A backend dev **approves your KYC** in the admin dashboard. Then **sign in again**.
3. A backend dev **adds test naira** with `npm run dev-credit -- --email you@example.com --asset ngn --amount 500000`. There's no in-app top-up yet.
4. For naira limits, a backend dev sets them in admin → **System → KYC limits**. They start at ₦0.
5. Reset codes (2.6) are printed in the API log if email isn't set up. Ask a backend dev.

**What works on the mock**

| Flow | Result |
| --- | --- |
| Register, login, refresh, reset | ✅ |
| KYC submit + admin approval | ✅ |
| Deposit address | ✅ becomes `usable` after **~15 seconds** |
| Quote + **buy** | ✅ `COMPLETED` immediately |
| **Sell** | ✅ but only for coins **bought** since the API last restarted. Coins added with `dev-credit` can't be sold (you get a 400). |
| **Swap** | ⚠️ stays **`PROCESSING` forever**. Test the progress UI; ask the backend to simulate completion. |
| **Crypto withdrawal** | ⚠️ stays **`PROCESSING` forever** (same reason) |
| Incoming crypto deposit | ⚠️ can't happen; the backend can simulate one |
| Naira withdrawal | ⚠️ off unless `NGN_WITHDRAWALS_ENABLED=true` in `api/.env`, or an owner switches it on in the admin dashboard (System → Withdrawals). On the pretend Payrep, an amount ending in `.51` is refused (refunded at once), and `.99` or `.77` stays `RECONCILING` (money still locked) |
| Naira deposit account + incoming naira | ⚠️ off unless `NGN_DEPOSITS_ENABLED=true`. Then 6.5 opens an account on the pretend Payrep, and a backend dev can send money into it with `POST /v1/admin/dev/payrep/simulate-deposit` (development only) |
| Gift cards, referrals, in-app notifications | ✅ |
| Push | ⚠️ only if the backend set up Firebase |

**Images from the Android emulator:** brand and social icon URLs are built from the server's `PUBLIC_API_URL`, which defaults to `http://localhost:3000`, unreachable from the emulator. Ask the backend to set `PUBLIC_API_URL=http://10.0.2.2:3000` (or the laptop's LAN IP).

**Swagger UI:** `http://<host>/docs`.

---

## Appendix F: Known limitations & upcoming changes

| # | Today | What's coming / what to do |
| --- | --- | --- |
| 1 | **No in-app naira top-up** | A funding endpoint is coming. Add a "Fund wallet" placeholder. |
| 2 | **Naira bank withdrawals** switched off (8.5–8.7) | Gate on `payoutAvailable` from 8.4 |
| 3 | Advanced verification (Tier 2/3) unavailable. **KYC document upload (4.3) works since 19 Oct**, but nothing asks for documents yet | Build the upload screen against 4.3 |
| 3a | **Basic verification (4.2) is switched off** until launch (`503 "Verification is not available yet."`) | Show `message`. Build the form now; it works against a test server with Basic switched on. |
| 4 | ~~Gift-card photos limited by the 1 MB request size~~ **Fixed 19 Oct:** 36 MB for 9.3 | — |
| 5 | **No email verification** after signup | Will be added. Plan for a "verify your email" step after 2.1. |
| 6 | **Withdrawals need only a token** | An OTP/2FA confirm step, saved addresses and a new-address waiting period are planned. Leave room in the confirm screen. |
| 7 | **Rate limiting is live** (§0.4.1) | Handle `429` + `Retry-After` on every call. Quotes (7.1) have no limit of their own yet; they share the 300-per-minute default. |
| 8 | **No deposit/withdrawal detail endpoints**, no tx hash or address in history | Use the lists + 7.4. Detail endpoints are planned. |
| 9 | **No pagination** beyond `limit=100` | Cursor paging will be added |
| 10 | ~~Phantom deposit after a buy~~ **Fixed (15 Oct):** a buy no longer creates a deposit or a "BTC added" notification | Nothing |
| 11 | ~~8.1 / 8.4 return 500 on a bad amount~~ **Fixed:** `400 "Enter an amount greater than zero"` (8.1 also: `"Choose a coin"`, `"Choose a network"`) | Show `message` |
| 12 | ~~Transfer-limit errors in 7.1 return 404~~ **Fixed:** now `400` | Show `message` |
| 13 | ~~Registering with a phone already in use returns 500~~ **Fixed:** it now returns the same `400` as a taken email | Show `message` |
| 14 | ~~8.7 returns 500 on invalid account details~~ **Fixed:** `400 "Unable to verify those bank details. Check the account and bank."`, or `503` if the bank check is unavailable. Nothing is debited. | Still call 8.6 first for a better screen |
| 15 | ~~Maintenance mode isn't enforced~~ **Fixed:** money-moving calls answer `503` with `code: "MAINTENANCE"` while it is on | Still check 13.1 on start for the full-screen page; handle the 503 on any money action |
| 16 | Error **wording** may change | Never write logic on message text |
| 17 | ~~Swap quote `rate` cut to 4 decimals~~ **Fixed:** a swap rate keeps 10 significant digits (e.g. `"0.00001423498765"`) | Show `rate` as sent |

---

## Appendix G: Endpoint index

| # | Method | Path | Token | KYC | Idempotency-Key | Success |
| --- | --- | --- | --- | --- | --- | --- |
| 1.1 | GET | `/health` | — | — | — | 200 |
| 2.1 | POST | `/v1/auth/register` | — | — | — | 201 |
| 2.2 | POST | `/v1/auth/login` | — | — | — | 200 |
| 2.3 | POST | `/v1/auth/refresh` | — | — | — | 200 |
| 2.4 | POST | `/v1/auth/logout` | ✅ | — | — | 204 |
| 2.5 | POST | `/v1/auth/change-password` | ✅ | — | — | 204 |
| 2.6 | POST | `/v1/auth/reset/request` | — | — | — | 200 |
| 2.7 | POST | `/v1/auth/reset/confirm` | — | — | — | 204 |
| 2.8 | GET | `/v1/auth/me` | ✅ | — | — | 200 |
| 3.1 | GET | `/v1/me` | ✅ | — | — | 200 |
| 3.2 | GET | `/v1/wallets` | ✅ | — | — | 200 |
| 4.1 | GET | `/v1/kyc` | ✅ | — | — | 200 |
| 4.2 | POST | `/v1/kyc/basic` | ✅ | — | — | 201 |
| 4.4 | GET | `/v1/kyc/states` | — | — | — | 200 |
| 4.3 | POST | `/v1/kyc/documents` (multipart) | ✅ | — | — | 201 / 200 |
| 5.1 | GET | `/v1/assets` | — | — | — | 200 |
| 5.2 | GET | `/v1/assets/{code}/networks?purpose=` | — | — | — | 200 |
| 6.1 | POST | `/v1/deposits/address` | ✅ | TIER_1 | — | 201 |
| 6.2 | GET | `/v1/deposits/addresses` | ✅ | — | — | 200 |
| 6.3 | GET | `/v1/deposits?limit=` | ✅ | — | — | 200 |
| 6.4 | GET | `/v1/deposits/ngn/account` | ✅ | — | — | 200 |
| 6.5 | POST | `/v1/deposits/ngn/account` | ✅ | TIER_1 | — | 201 |
| 7.1 | POST | `/v1/quotes` | ✅ | TIER_1 | — | 201 |
| 7.2 | POST | `/v1/trades` | ✅ | TIER_1 | **required** | 201 |
| 7.3 | GET | `/v1/trades?limit=` | ✅ | — | — | 200 |
| 7.4 | GET | `/v1/trades/{id}` | ✅ | — | — | 200 |
| 8.1 | GET | `/v1/withdrawals/quote?asset=&amount=&network=` | ✅ | — | — | 200 |
| 8.2 | POST | `/v1/withdrawals/crypto` | ✅ | TIER_1 | **required** | 201 |
| 8.3 | GET | `/v1/withdrawals?limit=` | ✅ | — | — | 200 |
| 8.4 | GET | `/v1/withdrawals/quote/ngn?amount=` | ✅ | — | — | 200 |
| 8.5 | GET | `/v1/withdrawals/ngn/banks` 🔒 | ✅ | — | — | 200 |
| 8.6 | POST | `/v1/withdrawals/ngn/verify-account` 🔒 | ✅ | TIER_1 | — | 201 |
| 8.7 | POST | `/v1/withdrawals/ngn` 🔒 | ✅ | TIER_1 | **required** | 201 |
| 9.1 | GET | `/v1/giftcards/catalogue` | — | — | — | 200 |
| 9.2 | GET | `/v1/giftcards/brands/{id}/image` | — | — | — | 200 |
| 9.3 | POST | `/v1/giftcards/trades` | ✅ | TIER_1 | — | 201 |
| 9.4 | GET | `/v1/giftcards/trades` | ✅ | — | — | 200 |
| 9.5 | GET | `/v1/giftcards/trades/{id}` | ✅ | — | — | 200 |
| 9.6 | GET | `/v1/giftcards/trades/{id}/images/{imageId}` | ✅ | — | — | 200 |
| 10.1 | GET | `/v1/referrals/code/{code}` | — | — | — | 200 |
| 10.2 | GET | `/v1/referrals/me` | ✅ | — | — | 200 |
| 10.3 | PUT | `/v1/referrals/username` | ✅ | — | — | 200 |
| 11.1 | GET | `/v1/notifications?limit=` | ✅ | — | — | 200 |
| 11.2 | POST | `/v1/notifications/read` | ✅ | — | — | 201 |
| 12.1 | POST | `/v1/devices` | ✅ | — | — | 201 |
| 12.2 | DELETE | `/v1/devices` | ✅ | — | — | 200 |
| 12.3 | GET | `/v1/devices` | ✅ | — | — | 200 |
| 13.1 | GET | `/v1/site` | — | — | — | 200 |
| 13.2 | GET | `/v1/site/logo` | — | — | — | 200 |
| 13.3 | GET | `/v1/site/social/{id}/icon` | — | — | — | 200 |
| 13.4 | GET | `/v1/content/pages` | — | — | — | 200 |
| 13.5 | GET | `/v1/content/pages/{slug}` | — | — | — | 200 |
| 13.6 | GET | `/v1/content/faqs` | — | — | — | 200 |

⚠️ = exists but not ready to use · 🔒 = returns 403 while naira payouts are switched off

**Everything under `/v1/admin/*` is for the staff dashboard only. The app must never call it**, and user tokens are rejected there.
