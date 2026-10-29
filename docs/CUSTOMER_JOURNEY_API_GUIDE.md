# DavoChain API: The Complete Customer Journey

**For:** anyone testing the API (Postman, curl) and the Flutter developers building the app.
**Written:** 23 October 2026, against the code now on `main`. Later changes (26 Oct) for the app: crypto addresses can be `FAILED` with Try again, some are made in advance, and "Session expired" can follow an emergency sign-out (`Reports/FLUTTER_WIRING_GUIDE.md`).

**Every response in this guide is real.** It was captured on 23 Oct 2026 by walking one customer through the whole journey (91 calls) on a test server with pretend providers. Your IDs, tokens, account numbers, rates and times will differ. Long tokens and IDs are shortened with `…`, the test email is shown as `ada.obi@example.com`, and the made-up test gift-card names are shown as "Amazon".

**Ready-made Postman collection:** [`postman/DavoChain-Customer-Journey.postman_collection.json`](postman/DavoChain-Customer-Journey.postman_collection.json) has every request below, in this order. It **saves and refreshes tokens by itself** and fills in IDs from one step to the next (section 2.6).

**For the fine detail of any endpoint** (every field, every error message), see [`FLUTTER_API.md`](FLUTTER_API.md). This guide is the walk-through; that one is the reference.

---

## Contents

1. [Before you start](#1-before-you-start)
2. [Sign-in tokens and how to refresh them](#2-sign-in-tokens-and-how-to-refresh-them)
3. [The journey, step by step](#3-the-journey-step-by-step)
   - [Step 1 · App start-up data](#step-1--app-start-up-data-no-sign-in)
   - [Step 2 · Register](#step-2--register)
   - [Step 3 · Log in](#step-3--log-in)
   - [Step 4 · Who am I](#step-4--who-am-i)
   - [Step 5 · Confirm the email address](#step-5--confirm-the-email-address)
   - [Step 5b · Create the transaction PIN](#step-5b--create-the-transaction-pin)
   - [Step 6 · Basic verification (KYC)](#step-6--basic-verification-kyc)
   - [Step 7 · Sign in again, then check the level](#step-7--sign-in-again-then-check-the-level)
   - [Step 8 · Get the naira account number](#step-8--get-the-naira-account-number)
   - [Step 9 · Money arrives in the naira account](#step-9--money-arrives-in-the-naira-account)
   - [Step 10 · Get a crypto deposit address (Quidax)](#step-10--get-a-crypto-deposit-address-quidax)
   - [Step 11 · Buy crypto](#step-11--buy-crypto)
   - [Step 12 · Sell crypto](#step-12--sell-crypto)
   - [Step 13 · Swap crypto to crypto](#step-13--swap-crypto-to-crypto)
   - [Step 14 · Withdraw naira to a bank account](#step-14--withdraw-naira-to-a-bank-account)
   - [Step 15 · Withdraw crypto to an outside address](#step-15--withdraw-crypto-to-an-outside-address)
   - [Step 16 · Sell a gift card](#step-16--sell-a-gift-card)
   - [Step 17 · Advanced verification](#step-17--advanced-verification-id-selfie-proof-of-address)
   - [Step 18 · Notifications and push](#step-18--notifications-and-push)
   - [Step 19 · Referrals](#step-19--referrals)
   - [Step 20 · Change or reset the password](#step-20--change-or-reset-the-password)
   - [Step 21 · Sign out](#step-21--sign-out)
4. [Statuses: what to show the customer](#4-statuses-what-to-show-the-customer)
5. [Errors the app must handle](#5-errors-the-app-must-handle)
6. [Testing on your own computer](#6-testing-on-your-own-computer)
7. [Endpoint index](#7-endpoint-index)

---

## 1. Before you start

### 1.1 Addresses

| Where | Base address |
|---|---|
| Your computer | `http://localhost:3000/v1` |
| Android emulator reaching your computer | `http://10.0.2.2:3000/v1` |
| Live | `https://<live API address>/v1` |

Every customer endpoint starts with `/v1`. Only two things don't: `GET /health` and the provider webhooks (`/webhooks/...`), which the app never calls.

### 1.2 Headers

| Header | When |
|---|---|
| `Content-Type: application/json` | Every request with a body (except file uploads, which are `multipart/form-data`) |
| `Authorization: Bearer <accessToken>` | Every request except the public ones (marked **Public** below) |
| `Idempotency-Key: <a new UUID>` | Required on the four requests that move money: `POST /trades`, `POST /withdrawals/ngn`, `POST /withdrawals/crypto`, `POST /transfers/crypto`. See [step 11](#step-11--buy-crypto). |
| `X-Transaction-Pin: <4 digits>` | **New 29 Oct 2026.** Required on the same four requests: the customer's transaction PIN ([step 5b](#step-5b--create-the-transaction-pin)). |

### 1.3 Money is always text

Amounts go in and come out as **strings**, e.g. `"50000"`, `"33.87985577"`, never as numbers. A phone's floating-point maths would lose kobo and satoshis. In Dart, use a decimal package, never `double`.

### 1.4 What an error looks like

```json
{ "message": "Incorrect email or password", "error": "Unauthorized", "statusCode": 401 }
```

- `message` is usually a sentence you can show as-is.
- On a form error (400), `message` can be a **list** of sentences, one per field: `{"message": ["Password must be at least 10 characters", "Password must contain a number"], ...}`.
- Some errors add a `code` so the app can react without reading the words, e.g. `"code": "EMAIL_NOT_VERIFIED"`. Section 5 lists them all.

### 1.5 Sending crypto to another DavoChain customer

Since 28 Oct 2026 a customer can send crypto to another DavoChain customer by **payment username** (`POST /v1/transfers/crypto`): free and instant. [`TRANSACTION_PIN.md`](TRANSACTION_PIN.md) §3 has the exact request and every reply. Naira cannot be sent this way. Other money going **out** is a withdrawal: naira to a bank account ([step 14](#step-14--withdraw-naira-to-a-bank-account)), or crypto to a wallet address ([step 15](#step-15--withdraw-crypto-to-an-outside-address)).

---

## 2. Sign-in tokens and how to refresh them

### 2.1 The two tokens

Register, log in and refresh all return two tokens:

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ…",
  "refreshToken": "C_Evv5wP9OBhuT1FKMCc-LxD0fMhmWcXdJe88YOfXm7LEycaVX-4M94crpgbyYqs",
  "expiresIn": "15m"
}
```

| Token | Lasts | What it's for |
|---|---|---|
| `accessToken` | **15 minutes** | Sent on every request: `Authorization: Bearer <accessToken>` |
| `refreshToken` | **30 days**, and it can be used **only once** | Swapped for a fresh pair of tokens when the access token runs out |

Think of the access token as a day pass that expires quickly, and the refresh token as a voucher you can trade in, once, for a new day pass plus a new voucher.

### 2.2 How you know the access token has expired

Any signed-in request answers **401**:

```json
{ "message": "Invalid or expired token", "error": "Unauthorized", "statusCode": 401 }
```

(With no token at all, the message is `"Missing bearer token"`.)

### 2.3 Refresh: `POST /v1/auth/refresh` (Public)

Send the **refresh** token. No `Authorization` header is needed.

```http
POST /v1/auth/refresh
Content-Type: application/json

{ "refreshToken": "C_Evv5wP9OBhuT1FKMCc-LxD0fMhmWcXdJe88YOfXm7LEycaVX-4M94crpgbyYqs" }
```

**200**, a brand-new pair:

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ…",
  "refreshToken": "gSrEfv7pmHUmRO_mezRFef9ltduWMQp355BPg1BMCFR5EzDViozXsF0v-LgCXEf2",
  "expiresIn": "15m"
}
```

**Save both.** The old refresh token is now dead. Then repeat the request that failed, once.

**401** means the customer must sign in again with their password:

```json
{ "message": "Session expired. Please sign in again.", "error": "Unauthorized", "statusCode": 401 }
```

### 2.4 The refresh rules (read these carefully)

1. **Refresh only once at a time.** If five requests fail with 401 at the same moment, run **one** refresh and let the other four wait for it. Two refreshes with the same token: one wins, the other gets 401.
2. **Never reuse an old refresh token.** Using one that was already traded in looks like theft, so the server signs out that whole session. This is the most common cause of "I keep getting logged out": the app saved the new access token but kept the old refresh token.
3. **Don't refresh on the sign-in screens.** A 401 from `login`, `register`, `refresh`, `change-password` or the reset routes means wrong details, not an expired token.
4. **A 429 on refresh is not a sign-out.** Wait the `Retry-After` seconds, then try again.

### 2.5 When the server signs the customer out on purpose

| What happened | What the server does | What the app does |
|---|---|---|
| **Basic verification approved** (step 6) | Every refresh token stops working at once. The access token keeps working for up to 15 minutes, with the *old* level. | Show "You're verified, please sign in again", clear the tokens, go to sign-in. |
| **Advanced verification approved** (step 17) | The same | The same |
| An admin approves or rejects verification by hand | The same | The same, when `GET /kyc` shows the change |
| **Password changed** (step 20) | All sessions end, including this phone's | Go to sign-in |
| **Password reset** with a code | All sessions end | Go to sign-in |
| Signed out (step 21) | That refresh token stops working | Clear the tokens |
| Account suspended | All sessions end; login refuses | Show the blocked screen with `message` |
| 30 days without refreshing, or an old refresh token reused | Refresh answers 401 | Go to sign-in |

> **Seen in the real run:** right after Basic verification was approved, `POST /auth/refresh` answered `401 "Session expired. Please sign in again."`. Logging in again worked, and the new token carried the new level.

### 2.6 Refreshing in Postman

The Postman collection does it for you:

- **Register**, **Log in** and **Refresh** save `accessToken`, `refreshToken` and the expiry time into the collection's variables.
- Before every signed-in request, a small script checks the expiry time. If the access token has less than a minute left, it calls `POST /v1/auth/refresh` first and saves the new pair.
- If the refresh fails (for example right after verification approval), the Postman console says **"Sign in again: run 'Log in'"**. Run **Log in** and carry on.

**To refresh by hand in Postman:** open **2. Account → Refresh token (by hand)** and press Send. The body already uses `{{refreshToken}}`, and the collection saves the new pair.

> **Checked on 23 Oct with Newman** (Postman's command-line runner): with the access token made to look expired, Postman called `/auth/refresh` by itself, saved the new pair, and "Who am I" answered 200. After a password change (which ends every session), the refresh was refused and the console said "Sign in again". The whole journey (63 requests, folders 0 to 15 except the email code and the photo uploads) also ran in one go with every step answering as this guide shows.

### 2.7 Refreshing in Flutter

A ready-made Dio interceptor (single shared refresh, save both tokens, retry once, sign out on failure) is in [`FLUTTER_API.md` Appendix D.2](FLUTTER_API.md#d2-api-client-with-safe-token-refresh). Store both tokens in `flutter_secure_storage`, never in `SharedPreferences`.

---

## 3. The journey, step by step

Each step shows the request, the real response, and what the app should do next.

### Step 1 · App start-up data (no sign-in)

| Request | What it gives you |
|---|---|
| `GET /health` (no `/v1`) | Is the server up |
| `GET /v1/site` | Company name, support email, social links, logo, **maintenance mode** |
| `GET /v1/assets` | Every coin and its networks |
| `GET /v1/assets/usdt/networks?purpose=deposit` | One coin's networks (`purpose` = `deposit` or `withdraw`) |
| `GET /v1/kyc/states` | Nigerian states and their LGAs, for the address form |
| `GET /v1/content/pages`, `GET /v1/content/pages/:slug`, `GET /v1/content/faqs` | About us, terms, privacy, FAQs |
| `GET /v1/giftcards/catalogue` | Gift cards we buy |

`GET /v1/site` (200):
```json
{
  "companyName": "Davochain",
  "supportEmail": "support@davochain.com",
  "phone": null,
  "address": "Lagos",
  "apps": { "iosVersion": null, "androidVersion": null, "iosStoreUrl": null, "androidStoreUrl": null },
  "maintenance": { "active": false, "message": null },
  "socials": [{ "label": "X", "url": "https://x.com/davochain", "iconUrl": null, "glyph": "&#120143;" }],
  "logoUrl": "/v1/site/logo?v=1792683361060"
}
```
If `maintenance.active` is `true`, show `maintenance.message`. Money actions are paused, but signing in and looking at balances still work.

`GET /v1/assets/usdt/networks?purpose=deposit` (200, first two of ten):
```json
[
  { "id": "bep20", "label": "Binance Smart Chain", "requiresTag": false, "confirmations": 1, "isDefault": true },
  { "id": "arbitrum", "label": "Arbitrum One", "requiresTag": false, "confirmations": 1, "isDefault": false }
]
```
The `id` is what you send as `network` later.

### Step 2 · Register

`POST /v1/auth/register` (Public)

```json
{
  "email": "ada.obi@example.com",
  "password": "Guide-password-2026",
  "firstName": "Ada",
  "lastName": "Obi",
  "phone": "+2348012345678"
}
```

| Field | Rules |
|---|---|
| `email` | A valid email, at most 254 characters. Each email can have only one account. |
| `password` | **10 to 128 characters, at least one letter and one number** |
| `firstName`, `lastName` | 1 to 60 characters |
| `phone` | **Required.** 7 to 15 digits, optional `+` at the start. Each phone number can have only one account. |
| `referralCode` | Optional, a friend's code |

**201**, signed in straight away:
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ…",
  "refreshToken": "n3ckdiDp60zZbr3dv4wnn2_-Pp3vgVsH0ZL5M0QYvw2pxFA0lkow9xEuBV5ddUr2",
  "expiresIn": "15m",
  "userId": "0ee3e69f-e9b0-4529-9b40-76f587ff13cc"
}
```
A 6-digit code is emailed straight away (step 5).

**Errors**

| Status | `message` | Why |
|---|---|---|
| 400 | `"Unable to register with those details"` | The email **or** the phone number already has an account. On purpose, it doesn't say which, so nobody can use sign-up to discover who uses DavoChain. |
| 400 | `["Password must be at least 10 characters", "Password must contain a number"]` | Form rules (a list) |
| 429 | (wait message) | 5 sign-ups per hour from one internet address |

### Step 3 · Log in

`POST /v1/auth/login` (Public)

```json
{ "email": "ada.obi@example.com", "password": "Guide-password-2026" }
```

**200:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ…",
  "refreshToken": "C_Evv5wP9OBhuT1FKMCc-LxD0fMhmWcXdJe88YOfXm7LEycaVX-4M94crpgbyYqs",
  "expiresIn": "15m"
}
```

| Status | `message` |
|---|---|
| 401 | `"Incorrect email or password"` (the same words whether the email exists or not) |
| 403 | Account locked after 5 wrong passwords in a row (15 minutes; the message gives the unlock time), or suspended |
| 429 | Too many attempts; wait `Retry-After` seconds |

### Step 4 · Who am I

`GET /v1/me` (200):
```json
{
  "id": "0ee3e69f-e9b0-4529-9b40-76f587ff13cc",
  "email": "ada.obi@example.com",
  "firstName": "Someone",
  "lastName": "Clean",
  "phone": "+2348085031533",
  "status": "ACTIVE",
  "emailVerified": false,
  "kyc": { "tier": "TIER_0", "status": "NOT_STARTED", "rejectionReason": null, "submittedAt": null },
  "walletReady": true,
  "createdAt": "2026-10-23T10:55:00.777Z"
}
```

- `emailVerified: false`: show the "enter the code we emailed you" screen (step 5).
- `GET /v1/auth/me` is a smaller version (id, email, tier, status), read from the token.
- With no token, it's 401 `"Missing bearer token"`.

### Step 5 · Confirm the email address

Until the email is confirmed, the customer can look around but **cannot** deposit, withdraw, trade, verify or open a naira account. Any of those answers **403**:

```json
{ "statusCode": 403, "code": "EMAIL_NOT_VERIFIED", "message": "Confirm your email address first. We sent a 6-digit code to …" }
```

**Send the code (again):** `POST /v1/auth/email/send-code`, no body. **200** `{ "sent": true }`. Sign-up already sends one, so this is for "Resend code".

**Confirm:** `POST /v1/auth/email/verify`

```json
{ "code": "424242" }
```

**200** `{ "verified": true }`

| Status | `message` |
|---|---|
| 400 | `"That code is not right. 4 tries left."` |
| 400 | The code expired, or no tries are left: ask for a new code |

After success, `GET /v1/me` shows `"emailVerified": true`. No new sign-in is needed.

### Step 5b · Create the transaction PIN

**New 29 Oct 2026.** Buying, selling, swapping, sending and withdrawing all need a 4-digit PIN in the header `X-Transaction-Pin`. Make it once, before the first of those:

```http
POST /v1/me/transaction-pin
Authorization: Bearer <accessToken>
Content-Type: application/json

{ "password": "<their password>", "pin": "4826" }
```

**201** `{ "isSet": true, "setAt": "2026-10-29T09:12:44.120Z", "lockedUntil": null, "triesLeft": 5 }`

`GET /v1/me` shows `"hasTransactionPin": true` from then on. Easy PINs (`1234`, `0000`, `1212`…) answer `400 PIN_WEAK`. Five wrong PINs in a row lock it for 30 minutes. Change PIN, Forgot PIN and every error are in [`TRANSACTION_PIN.md`](TRANSACTION_PIN.md).

### Step 6 · Basic verification (KYC)

**Check where they are:** `GET /v1/kyc` (200, before verification; shortened):
```json
{
  "tier": "TIER_0", "status": "NOT_STARTED", "level": "NONE", "basicState": null,
  "underReview": false, "attemptsLeftToday": 3, "attemptsLeftTotal": 10,
  "advanced": {
    "identity": { "state": "NONE", "reason": null, "attemptsLeft": { "today": 3, "total": 10 } },
    "address": { "state": "NONE", "reason": null, "attemptsLeft": { "today": 3, "total": 10 } },
    "recencyMonths": 3
  },
  "limits": { "current": { "deposit": { "singleNgn": null, "dailyNgn": null, "usedTodayNgn": "0.00", "remainingTodayNgn": null, "currency": "NGN" }, "withdraw": { "…": "…" } }, "tiers": ["…"] }
}
```

**Submit:** `POST /v1/kyc/basic`

```json
{
  "idType": "BVN",
  "idNumber": "33312345678",
  "firstName": "Someone",
  "lastName": "Clean",
  "dateOfBirth": "1995-03-03",
  "address": { "street": "12 Allen Avenue", "city": "Ikeja", "state": "Lagos", "lga": "Ikeja" },
  "stateOfOrigin": "Lagos",
  "country": "NG"
}
```

| Field | Rules |
|---|---|
| `idType` | `"BVN"` or `"NIN"` |
| `idNumber` | Exactly 11 digits |
| `firstName`, `lastName` (`middleName` optional) | Letters, spaces, `'`, `.`, `-`. Must match the ID record. |
| `dateOfBirth` | `YYYY-MM-DD`, must match the ID record |
| `address.state` and `address.lga` | Must be a real state and one of its LGAs, from `GET /v1/kyc/states` |
| `address.postcode` | Optional, 6 digits |
| `country` | `"NG"` |

**201:**
```json
{ "state": "APPROVED", "level": "BASIC", "message": "You are verified." }
```

`state` can also be `IN_REVIEW` (a person checks it; show `message`) or `REJECTED` (show `message`; they can try again while attempts are left).

**400** example: `{"message": ["BVN and NIN are 11 digits", "Use YYYY-MM-DD"], ...}`

> **Testing locally:** with the pretend Dojah, any BVN starting `333` is "Someone Clean, born 1995-03-03". Use those names and that date. `11111111111` is refused. Each number can verify only one account, so change the last digits for each new tester. With `KYC_BASIC_ENABLED` off you get `503 "Verification is not available yet."` (section 6).

### Step 7 · Sign in again, then check the level

**Approval ends every session (section 2.5).** A refresh now answers `401 "Session expired. Please sign in again."`. So log in again (step 3), then:

`GET /v1/me/level` (200, shortened):
```json
{
  "level": "BASIC", "levelName": "Basic", "tier": "TIER_1", "advancedInProgress": false,
  "actions": [
    { "action": "BUY", "label": "buy crypto", "allowed": true, "currency": "USD", "minPerTx": null, "maxPerTx": null, "maxPerDay": null, "usedToday": "0.00", "remainingToday": null },
    { "action": "SELL", "label": "sell crypto", "allowed": true, "currency": "USD", "…": "…" }
  ],
  "cooloffs": { "withdrawalsOpenAt": null }
}
```
`actions` says what this customer may do and how much: buy, sell, swap, naira deposit and withdrawal, crypto deposit and withdrawal, gift-card sale. Use it to grey out buttons and show limits. `cooloffs.withdrawalsOpenAt` is set when withdrawals are still waiting after sign-up or a password change.

### Step 8 · Get the naira account number

Each customer gets their own Payrep account number. Money sent to it from any Nigerian bank lands in their DavoChain naira balance.

**Updated 23 Oct 2026 (afternoon): no BVN or NIN is needed.** Once Basic verification is approved, DavoChain opens the account at Payrep **by itself**, named after the customer exactly as their ID shows it, with DavoChain's name in front. A background job does it within a minute, and the first `GET` below does it straight away. The app never asks for the BVN again.

**Just ask for it:** `GET /v1/deposits/ngn/account` (after signing in again, step 7)

**200** (the first GET after approval opened it there and then; real answer, pretend Payrep):
```json
{ "accountNumber": "6510958022", "accountName": "DavoChain-Someone Clean", "bankName": "Payrep MFB", "status": "ACTIVE" }
```
Every later `GET` returns the same account.

**202** while it's being opened:
```json
{ "status": "PENDING", "message": "We're setting up your account. Try again in a few minutes." }
```
Show "Setting up your account…" and ask again every 3–5 seconds. It's usually ready in seconds. If Payrep was slow to answer, DavoChain checks Payrep's list before ever trying again, so a customer can never end up with two accounts. A push **`ngn_account.ready`** ("Your naira account is ready") arrives when it's done.

**404**: only for someone who may not have one yet, with the reason:
```json
{ "statusCode": 404, "code": "NO_VIRTUAL_ACCOUNT", "eligible": false, "reason": "Verify your identity (Tier 1) to get a naira account.", "message": "You have no naira deposit account yet." }
```

**The "open it now" button (optional):** `POST /v1/deposits/ngn/account` with an **empty body** `{}`. It answers `201` (opened now), `200` (already had one) or `202` (on its way). An older app that still sends `{ "bvn": "…" }` gets the same answer: the number is ignored, never sent to Payrep and never stored.

**What to show:** the account number (with a copy button), the bank name and the account name: "Send money to this account from any bank app."

**How it works behind the scenes:** DavoChain calls Payrep's `create_account` with only `{ "account_name": "<name on the ID>", "is_pool": true, "pool_account_number": "<DavoChain's main account>" }`. Payrep adds the "DavoChain-" prefix on live. (On Payrep's sandbox the prefix isn't added; there a test account comes back as just "Ada Chioma Obi".)

> The code calls this a "virtual account" in places. That's an old name from Flutterwave. It is a Payrep account under DavoChain's business.

### Step 9 · Money arrives in the naira account

**For real:** the customer transfers from their bank app to the account number. Payrep tells DavoChain, DavoChain checks with Payrep, and the balance goes up, usually within seconds (at most about 30 minutes if Payrep's message is late).

**On a test computer** (pretend Payrep only; admin token needed; in Postman: folder 5, "Simulate a ₦200,000 bank transfer in"): `POST /v1/admin/dev/payrep/simulate-deposit`
```json
{ "userId": "0ee3e69f-e9b0-4529-9b40-76f587ff13cc", "amount": "200000", "payerName": "SOMEONE CLEAN" }
```
**200** `{ "transactionId": "MOCKTP1792752903939221243", "webhookStatus": 200 }`. More on this in [`Reports/PAYREP_PAYMENT_TESTING_GUIDE.md`](../../Reports/PAYREP_PAYMENT_TESTING_GUIDE.md).

**Balances:** `GET /v1/wallets` (200, first two of 18):
```json
[
  { "asset": "ngn", "name": "Nigerian Naira", "isFiat": true, "available": "200000.00", "locked": "0.00", "total": "200000.00" },
  { "asset": "btc", "name": "Bitcoin", "isFiat": false, "available": "0.00000000", "locked": "0.00000000", "total": "0.00000000" }
]
```
`available` can be spent. `locked` is held by something in progress (a withdrawal on its way). `total` = both.

**Deposit history:** `GET /v1/deposits?limit=10` (200):
```json
[
  { "id": "1ef3d5aa-c6c7-4d6e-8354-3f5df1716d88", "asset": "ngn", "amount": "200000", "status": "COMPLETED", "reason": null, "provider": "PAYREP", "counterpartyBank": "Access Bank", "createdAt": "2026-10-23T10:55:04.020Z", "completedAt": "2026-10-23T10:55:04.011Z" }
]
```

A deposit can be `ON_HOLD` when it's above the customer's limit or the sender's name doesn't match. An admin then releases it, or sends it back to the sender.

**Notification:** `GET /v1/notifications?limit=5` shows `"₦200000.00 added"` (step 18).

### Step 10 · Get a crypto deposit address (Quidax)

**1. Pick the network** from `GET /v1/assets/usdt/networks?purpose=deposit`.

**2. Ask for the address:** `POST /v1/deposits/address`
```json
{ "asset": "usdt", "network": "trc20" }
```

**201**. The first time, Quidax is still creating it:
```json
{ "asset": "usdt", "network": "trc20", "networkLabel": "Tron Network", "status": "PENDING", "address": null, "destinationTag": null, "requiresTag": false, "confirmations": 1, "usable": false }
```

**3. Wait until it's ready:** call `GET /v1/deposits/addresses` (or the same POST again) every 3 to 5 seconds, for up to about 2 minutes. When ready:
```json
[
  { "asset": "usdt", "network": "trc20", "networkLabel": "Tron Network", "status": "ACTIVE", "address": "TQrY8tryqsYVCYS3MFbtffiPp2ccyn4STm", "destinationTag": null, "requiresTag": false, "confirmations": 1, "usable": true }
]
```
**Only show the address and QR code when `usable` is `true`.** If `requiresTag` is `true` (some coins, such as XRP), show the `destinationTag` too, with a warning that without it the coins are lost. A push `address.ready` also arrives when it's done.

(On a test computer the address looks like `mock_usdt_12c67a7f-7de`.)

**Wrong network:** **404** `{ "message": "USDT is not available on not-a-network", ... }`

When coins arrive, they show in `GET /v1/deposits` and `GET /v1/wallets`, and a notification is sent.

### Step 11 · Buy crypto

Two calls: get a price (a **quote**), then accept it (a **trade**).

**1. Quote:** `POST /v1/quotes`
```json
{ "side": "buy", "fromAsset": "ngn", "toAsset": "usdt", "amount": "50000" }
```
For `buy`, `amount` is in the **from** asset (₦50,000 to spend).

**201:**
```json
{
  "quoteId": "a54988b6-3844-4acd-ade5-56ef4f44283b",
  "side": "BUY", "fromAsset": "ngn", "toAsset": "usdt",
  "fromAmount": "49999.99", "toAmount": "33.87985577",
  "rate": "1475.8032", "fee": "0.00000000", "feeAsset": null,
  "minimum": "5.00", "maximum": "2000.00",
  "expiresAt": "2026-10-23T10:55:16.559Z", "ttlSeconds": 12,
  "availableBalance": "200000.00"
}
```
**A quote lasts only `ttlSeconds` (about 12 seconds).** Show a countdown; when it runs out, fetch a new quote. `minimum` and `maximum` are in US dollars.

**2. Trade:** `POST /v1/trades`
```http
POST /v1/trades
Authorization: Bearer <accessToken>
Idempotency-Key: 3f1c9a52-6b1e-4f7a-9d0e-0a1b2c3d4e5f
X-Transaction-Pin: 4826
Content-Type: application/json

{ "quoteId": "a54988b6-3844-4acd-ade5-56ef4f44283b" }
```

**201:**
```json
{ "transactionId": "37e74c23-9822-4b63-b18a-8c924d5a6e9f", "status": "COMPLETED", "fromAsset": "ngn", "fromAmount": "50000.00", "toAsset": "usdt", "toAmount": "33.87985577", "rate": "1475.8032" }
```

**About `Idempotency-Key`.** Make a new random UUID when the customer taps "Buy", and keep it for that one tap. If the network drops and you're not sure the trade went through, **send the same request with the same key**. The server answers with the first result instead of buying twice. In the real run, repeating the same key returned the same `transactionId`.

| Situation | Answer |
|---|---|
| Same quote, **same** key (a retry) | 201, the same trade again; nothing extra bought |
| Same quote, **new** key | 400 `"This quote has already been used"` |
| No `Idempotency-Key` header | 400 `"Idempotency-Key header is required for this request"` |
| Quote expired | 400; get a new quote |
| Too big | 400 `"Maximum single trade is $2000.00."` |
| Not enough balance | 400 with a message saying so |

**Check one trade:** `GET /v1/trades/37e74c23-9822-4b63-b18a-8c924d5a6e9f` (200):
```json
{ "id": "37e74c23-9822-4b63-b18a-8c924d5a6e9f", "type": "BUY", "status": "COMPLETED", "fromAsset": "ngn", "fromAmount": "50000", "toAsset": "usdt", "toAmount": "33.879855772501533891", "reason": null, "createdAt": "2026-10-23T10:55:04.657Z", "completedAt": "2026-10-23T10:55:04.672Z" }
```
The history shows the exact stored amount (many decimals); round it for display to the coin's `displayScale` from `GET /v1/assets` (USDT: 6, BTC: 8).

### Step 12 · Sell crypto

The same two calls, with `side: "sell"`. `amount` is the crypto being sold.

`POST /v1/quotes`
```json
{ "side": "sell", "fromAsset": "usdt", "toAsset": "ngn", "amount": "5" }
```
**201:**
```json
{ "quoteId": "837cdd12-a52e-4af9-b844-eb00a1d5d6b0", "side": "SELL", "fromAsset": "usdt", "toAsset": "ngn", "fromAmount": "5.00000000", "toAmount": "7096.10", "rate": "1419.2200", "fee": "0.00000000", "feeAsset": null, "minimum": "5.00", "maximum": "2000.00", "expiresAt": "2026-10-23T10:55:16.806Z", "ttlSeconds": 12, "availableBalance": "33.879855" }
```
`POST /v1/trades` with `{ "quoteId": "837cdd12-…" }` and a new `Idempotency-Key`, **201:**
```json
{ "transactionId": "849e385d-9281-4449-bf00-00a9b9c43b02", "status": "COMPLETED", "fromAsset": "usdt", "fromAmount": "5.00000000", "toAsset": "ngn", "toAmount": "7096.10", "rate": "1419.2200" }
```

### Step 13 · Swap crypto to crypto

`side: "swap"`, from one coin to another.

`POST /v1/quotes`
```json
{ "side": "swap", "fromAsset": "usdt", "toAsset": "btc", "amount": "10" }
```
**201** (a swap shows its fee):
```json
{ "quoteId": "e9a34ffc-e0d2-41f7-871e-1ee955f07b0f", "side": "SWAP", "fromAsset": "usdt", "toAsset": "btc", "fromAmount": "10.00000000", "toAmount": "0.00007766", "rate": "0.000009708737864", "fee": "0.00001941", "feeAsset": "btc", "minimum": "4.00", "maximum": "2000.00", "expiresAt": "2026-10-23T10:55:16.981Z", "ttlSeconds": 12, "availableBalance": "28.879855" }
```
`POST /v1/trades`, **201**. **A swap starts as `PROCESSING`**, because Quidax finishes it:
```json
{ "transactionId": "64c153f5-0c96-4948-9c9d-654bf7405514", "status": "PROCESSING", "fromAsset": "usdt", "fromAmount": "10.00000000", "toAsset": "btc", "toAmount": "0.00007766", "rate": "0.00000970" }
```
Call `GET /v1/trades/64c153f5-…` every 2 to 3 seconds until the status changes. In the real run it was `COMPLETED` within half a second.

**All trades:** `GET /v1/trades?limit=10`, newest first.

### Step 14 · Withdraw naira to a bank account

Withdrawals go only to a bank account the customer **saved first, with their password**. That stops a thief with an unlocked phone from emptying the account to a new bank.

**1. Banks:** `GET /v1/withdrawals/ngn/banks` (200):
```json
[ { "code": "000014", "name": "Access Bank" }, { "code": "000013", "name": "GTBank" } ]
```
Use the `code` exactly as given; codes come from Payrep's list. (Test computer codes shown; the live list differs.)

**2. Check the account name:** `POST /v1/withdrawals/ngn/verify-account`
```json
{ "accountNumber": "0123456789", "bankCode": "000014" }
```
**201** `{ "accountName": "MOCK ACCOUNT 6789", "accountNumberLast4": "6789", "bankCode": "000014" }`. Show the name so the customer can confirm it's the right person.

**3. Save it** (password required): `POST /v1/me/bank-accounts`
```json
{ "bankCode": "000014", "accountNumber": "0123456789", "nickname": "My GTB", "password": "Guide-password-2026" }
```
**201:**
```json
{ "id": "216be5cc-af03-49f7-a3da-e19431103f63", "bankCode": "000014", "bankName": "Access Bank", "accountNumberMasked": "******6789", "accountName": "MOCK ACCOUNT 6789", "nickname": "My GTB", "usableFrom": "2026-10-23T10:55:05.858Z", "usableNow": true }
```
- Wrong password: 401 `"Incorrect password"`.
- `usableNow: false` means the admin set a waiting time for new accounts. Show "usable from" `usableFrom`.
- List them with `GET /v1/me/bank-accounts` (`{ "max": 5, "items": [...] }`). Remove one with `DELETE /v1/me/bank-accounts/:id`.

**4. The fee:** `GET /v1/withdrawals/quote/ngn?amount=10000` (200):
```json
{ "asset": "ngn", "amount": "10000.00", "feeNgn": "0.00", "totalDebited": "10000.00", "youReceive": "10000.00", "band": null, "feeConfigured": false, "limit": { "allowed": true, "reason": null, "singleLimit": null, "dailyLimit": null, "usedToday": "0.00", "remainingToday": null, "currency": "NGN" }, "payoutAvailable": true }
```
`payoutAvailable: false` means naira payouts are switched off right now; show a message instead of the button. `limit.allowed: false` comes with a `reason`.

**5. Withdraw:** `POST /v1/withdrawals/ngn` with a new `Idempotency-Key` and the `X-Transaction-Pin` header
```json
{ "amount": "10000", "savedBankAccountId": "216be5cc-af03-49f7-a3da-e19431103f63" }
```
**201:**
```json
{ "transactionId": "5669c19b-9128-4ce9-ab28-9ce175da874e", "status": "PROCESSING", "asset": "ngn", "amount": "10000.00", "feeNgn": "0.00", "totalDebited": "10000.00", "bankName": "Access Bank", "accountNumberLast4": "6789" }
```
The money is **locked** (shown in `locked` in `/wallets`) while the bank transfer goes. It becomes `COMPLETED` when the bank confirms. If it fails, it's `FAILED` and the money is back in `available`.

| Situation | Answer |
|---|---|
| Typing bank details instead of choosing a saved account | 400, "Choose a saved bank account" |
| No `Idempotency-Key` | 400 `"Idempotency-Key header is required for this request"` |
| A saved account that was removed | 404 `"Saved account not found"` |
| Saved too recently | 403 `code: "DESTINATION_COOLING_OFF"`, with when it can be used |

**History:** `GET /v1/withdrawals?limit=10` (naira and crypto together; naira rows have `bankName` and `accountNumberLast4`).

### Step 15 · Withdraw crypto to an outside address

**1. Network** from `GET /v1/assets/usdt/networks?purpose=withdraw`.

**2. Fee:** `GET /v1/withdrawals/quote?asset=usdt&network=erc20&amount=10` (200):
```json
{ "asset": "usdt", "network": "erc20", "amount": "10.000000", "networkFee": "1.000000", "platformFee": "0.000000", "platformFeeUsd": "0.00", "totalFee": "1.000000", "totalDeducted": "11.000000", "youReceive": "10.000000" }
```
The customer receives `amount`; `totalDeducted` (amount + fees) comes off their balance.

**3. Save the address** (password required): `POST /v1/me/crypto-addresses`
```json
{ "asset": "usdt", "network": "erc20", "address": "0x52908400098527886E0F7030069857D2E4169EE7", "nickname": "My Binance", "password": "Guide-password-2026" }
```
**201:**
```json
{ "id": "8b9b3395-e0b0-4081-863c-50ce2b47be97", "assetCode": "usdt", "networkId": "erc20", "networkLabel": "Ethereum Network", "address": "0x52908400098527886E0F7030069857D2E4169EE7", "destinationTag": null, "nickname": "My Binance", "usableFrom": "2026-10-23T10:55:06.177Z", "usableNow": true }
```
Add `destinationTag` for coins that need one. A badly formed address gets 400 "That does not look like a valid … address". List with `GET /v1/me/crypto-addresses` (`max: 10`); remove with `DELETE /v1/me/crypto-addresses/:id`.

**4. Withdraw:** `POST /v1/withdrawals/crypto` with a new `Idempotency-Key` and the `X-Transaction-Pin` header
```json
{ "amount": "10", "savedCryptoAddressId": "8b9b3395-e0b0-4081-863c-50ce2b47be97" }
```
**201:**
```json
{ "transactionId": "cb5acf8e-4b4e-4e65-9236-4cbdffa1ffe6", "status": "PROCESSING", "asset": "usdt", "amount": "10.000000", "address": "0x52908400098527886E0F7030069857D2E4169EE7" }
```
In `/wallets`, the 11 USDT (10 + fee) shows as `locked` until Quidax sends it. It becomes `COMPLETED`, or `FAILED` with the coins returned.

### Step 16 · Sell a gift card

**1. What we buy:** `GET /v1/giftcards/catalogue` (Public, 200):
```json
[
  { "id": "368d134a-…", "name": "Shopping", "brands": [
    { "id": "e62a67c4-…", "name": "Amazon", "imageUrl": null, "types": [
      { "id": "f0a39be6-e046-44cf-9106-615a079f471c", "name": "Amazon USA (e-code)", "currency": "USD", "currencySymbol": "$", "currencySymbolFirst": true, "minAmount": "10.00", "maxAmount": "500.00", "rateNgn": "1000.00" }
    ] }
  ] }
]
```
`rateNgn` is naira per 1 unit of the card's currency ($50 × ₦1,000 = ₦50,000).

**2. Submit:** `POST /v1/giftcards/trades`
```json
{ "typeId": "f0a39be6-e046-44cf-9106-615a079f471c", "faceValue": "50", "code": "AMZN-1234-5678-9012" }
```
Send the `code`, or `images` (up to 5 photos as `data:image/jpeg;base64,…` strings, made smaller on the phone first), or both. At least one is required.

**201:**
```json
{ "id": "131d7ebb-9f12-4cb0-ab09-8b0322b51d5f", "brand": "Amazon", "type": "Amazon USA (e-code)", "currency": "USD", "currencySymbol": "$", "currencySymbolFirst": true, "faceValue": "50.00", "rateNgn": "1000.00", "expectedNgn": "50000.00", "status": "PENDING", "creditedNgn": null, "approvedValue": null, "reason": null, "images": [], "createdAt": "2026-10-23T10:55:06.333Z", "reviewedAt": null }
```

**3. A person checks the card.** Then `GET /v1/giftcards/trades/:id` shows:
```json
{ "…": "…", "status": "APPROVED", "creditedNgn": "50000.00", "approvedValue": "50.00", "reviewedAt": "2026-10-23T10:55:06.380Z" }
```
The naira is in the balance, with a notification. `REJECTED` comes with a `reason`. All of them: `GET /v1/giftcards/trades`.

### Step 17 · Advanced verification (ID, selfie, proof of address)

Advanced raises the limits. It's in two parts: identity (ID plus selfie), then proof of address. Basic must be done first.

**1. Upload each picture:** `POST /v1/kyc/documents` as **multipart/form-data** (not JSON):

| Form field | Value |
|---|---|
| `type` | `NATIONAL_ID`, `ID_BACK`, `PASSPORT`, `DRIVERS_LICENSE`, `SELFIE` or `PROOF_OF_ADDRESS` |
| `file` | The image (JPEG or PNG; a PDF for proof of address). Up to 10 MB; resize on the phone first. |

**201** `{ "id": "0bca314f-baf8-4145-bea5-1e1de38d2bdd", "type": "NATIONAL_ID", "status": "PENDING", "uploadedAt": "2026-10-23T10:55:06.493Z" }`. Keep each `id`. Uploading the very same file again returns 200 with the first record.

**2. Identity:** `POST /v1/kyc/advanced/identity`
```json
{ "idType": "NATIONAL_ID", "frontDocumentId": "0bca314f-…", "backDocumentId": "8cc8a25d-…", "selfieDocumentId": "7a6caa98-…" }
```
`idType`: `NATIONAL_ID`, `PASSPORT` or `DRIVERS_LICENSE`. `backDocumentId` is optional (a passport has no back).

**202** `{ "verificationId": "8bf33e97-6e44-49b7-a630-3fa538ad1aa8", "state": "CHECKING" }`

Call `GET /v1/kyc` every 2 to 3 seconds while `advanced.identity.state` is `CHECKING`. Then:
```json
{ "tier": "TIER_2", "level": "ADVANCED_IN_PROGRESS", "advanced": { "identity": { "state": "APPROVED", "reason": null, "attemptsLeft": { "today": 2, "total": 9 } }, "address": { "state": "NONE", "…": "…" } } }
```
Other states: `IN_REVIEW` (a person decides), or `REJECTED` with a customer-friendly `reason`, e.g. `"This ID has expired. Please use one that's still valid."`.

**3. Proof of address:** upload with `type: "PROOF_OF_ADDRESS"`, then `POST /v1/kyc/advanced/address`
```json
{ "kind": "UTILITY_BILL", "documentId": "41d4ec14-0f8f-46f9-8d8c-19ec9a55a84f" }
```
`kind`: `UTILITY_BILL`, `BANK_STATEMENT`, `GOVERNMENT_LETTER` or `TENANCY`. It must be dated within the last `recencyMonths` (3).

**202** `{ "verificationId": "1e96ce00-…", "state": "CHECKING" }`. Poll `GET /v1/kyc` again; when approved: `"tier": "TIER_3", "level": "ADVANCED"`.

**4. Sign in again.** Each approval ends the sessions, as in step 7.

If Advanced is switched off by the admin, these answer 503. While one submission waits for a person, a second answers 409.

### Step 18 · Notifications and push

**Feed:** `GET /v1/notifications?limit=3` (200):
```json
{
  "unread": 10,
  "items": [
    { "id": "51d397d8-…", "type": "deposit.credited", "title": "₦50000.00 for your Amazon card", "body": "It has been added to your naira balance.", "transactionId": "ad862ff1-…", "readAt": null, "createdAt": "2026-10-23T10:55:06.422Z" },
    { "id": "2b736d00-…", "type": "withdrawal.submitted", "title": "Withdrawal requested: 10.000000 USDT", "body": "To 0x52908400…169EE7. We will confirm when it leaves.", "transactionId": "cb5acf8e-…", "readAt": null, "createdAt": "2026-10-23T10:55:06.265Z" }
  ]
}
```
**Mark as read:** `POST /v1/notifications/read` with `{ "ids": ["51d397d8-…"] }`, or `{}` for all. **201** `{ "updated": 10 }`.

**Push (Firebase):** after sign-in, register the phone's FCM token:
`POST /v1/devices` `{ "token": "<FCM token>", "platform": "ANDROID", "appVersion": "1.0.0" }` → **201** `{ "id": "2ec4bf2a-…", "platform": "ANDROID", "createdAt": "…" }`.
`platform` is `ANDROID`, `IOS` or `WEB`. On sign-out: `DELETE /v1/devices` with `{ "token": "<FCM token>" }` → **200** `{ "unregistered": true }`. List: `GET /v1/devices`.

### Step 19 · Referrals

`GET /v1/referrals/me` (200):
```json
{ "code": "SOMMAWR", "link": "https://davochain.com/r/SOMMAWR", "username": null, "canSetUsername": true, "offer": { "isEnabled": false, "headline": "Invite friends, earn naira", "terms": null, "theyGetNgn": "0.00", "youGetNgn": "0.00", "unlockTier": "TIER_1", "tradeVolumeNgn": "0.00" }, "totals": { "earnedNgn": "0.00", "pendingNgn": "0.00", "referrals": 0, "completed": 0 }, "signupBonus": null, "referrals": [] }
```
- **Custom code:** `PUT /v1/referrals/username` `{ "username": "adaobi" }`. **At most 7 characters**: a longer one gets 400 `"A username can be at most 7 characters."`.
- **Check a friend's code before sign-up** (Public): `GET /v1/referrals/code/SOMMAWR`.

### Step 20 · Change or reset the password

**Change (signed in):** `POST /v1/auth/change-password`
```json
{ "currentPassword": "Guide-password-2026", "newPassword": "Guide-password-2027" }
```
**204** (no body). **Every session ends, including this phone's**: go to sign-in. Withdrawals may wait for a while after a password change (`COOLING_OFF`).

**Forgot password** (Public):
1. `POST /v1/auth/reset/request` `{ "email": "ada.obi@example.com" }` → **200** `{ "message": "If that email belongs to an account, a s…" }`. The answer is the same whether the email exists or not.
2. `POST /v1/auth/reset/confirm` `{ "email": "ada.obi@example.com", "code": "123456", "newPassword": "Guide-password-2028" }` → **204** (no body) on success; 400 `"That code is not right. 4 tries left."` on a wrong code. All sessions end; sign in with the new password. A reset also unlocks an account locked by wrong passwords.

### Step 21 · Sign out

`POST /v1/auth/logout`
```json
{ "refreshToken": "2AOMAa-PIvGhb1GRWLYUe4uVO6ef3y8mLjl2EILNn6BdP1ltMB2EQLWhU5lbBME2" }
```
**204.** Then delete both tokens from the phone and unregister the push token (step 18). That refresh token now answers `401 "Session expired. Please sign in again."`.

---

## 4. Statuses: what to show the customer

**Trades, deposits and withdrawals** (`status`):

| Status | Meaning | Show |
|---|---|---|
| `PENDING` | Accepted, not finished | "Processing…" |
| `PROCESSING` | A provider is completing it (swaps, withdrawals) | "Processing…" and check again |
| `ON_HOLD` | A naira deposit waiting for review | "Under review", plus `reason` |
| `COMPLETED` | Done | Success |
| `FAILED` | Didn't go through; the money is back in the balance | `reason` |
| `RECONCILING` | The result isn't known yet; the money is held safely while we check with the provider | "We're confirming this with our provider. Your funds are safe." **No retry button, and never say "failed".** |

**Verification:** `GET /v1/kyc` `level` is `NONE` → `BASIC` → `ADVANCED_IN_PROGRESS` → `ADVANCED`. **Use `level`.** DavoChain's levels are None, Basic and Advanced. The `tier` field (`TIER_0` to `TIER_3`) is the **old name for the same thing**, still sent only so older app builds don't break, and it will be removed later. Never show it or build on it (`FLUTTER_API.md` §0.6.1). Each step's `state` is `NONE`, `CHECKING`, `IN_REVIEW`, `APPROVED` or `REJECTED`.

**Crypto deposit address:** `PENDING` (wait) → `ACTIVE` with `usable: true` (show it).

**Gift card:** `PENDING` → `APPROVED` (paid) or `REJECTED` (with `reason`).

---

## 5. Errors the app must handle

| Status | Body | What it means | What the app does |
|---|---|---|---|
| 401 | `"Missing bearer token"` | No token sent | Send the token |
| 401 | `"Invalid or expired token"` | The access token has expired | Refresh once (section 2), retry once |
| 401 | `"Session expired. Please sign in again."` | Refresh refused | Go to sign-in |
| 401 | `"Incorrect password"` | Wrong password when saving a bank account or address | Ask again; **don't** refresh |
| 403 | `{ "code": "PIN_NOT_SET" }` | No transaction PIN yet | Open "Create your PIN" (step 5b) |
| 403 | `{ "code": "PIN_REQUIRED" }` | The `X-Transaction-Pin` header was missing | Show the PIN pad |
| 403 | `{ "code": "PIN_WRONG", "triesLeft": 3 }` | Wrong PIN | Show `message`; try again with a new Idempotency-Key |
| 403 | `{ "code": "PIN_LOCKED", "until": "…" }` | Five wrong PINs: locked for 30 minutes | Show `message` and a **Forgot PIN** button |
| 403 | `code: "EMAIL_NOT_VERIFIED"` | Email not confirmed | Code screen (step 5) |
| 403 | `requiredTier`, `currentTier` | Not verified enough | Verification screen |
| 403 | `code: "NOT_ALLOWED_AT_LEVEL"` | This level may not do this | `requiredLevel` set: verification screen; `null`: show `message` |
| 403 | `code: "COOLING_OFF"`, `until` | A new account, or a password just changed: withdrawals wait | Show `message` |
| 403 | `code: "DESTINATION_COOLING_OFF"` | The saved account or address is too new | Show `message` |
| 403 | `code: "VERIFICATION_PENDING"` or `"ACCOUNT_UNDER_REVIEW"` | Being checked | Show `message` exactly as sent |
| 400 | `message` is a list | Form errors | Show each under its field |
| 400 | `"Idempotency-Key header is required for this request"` | Missing header on a money request | Add a UUID |
| 404 | `code: "NO_VIRTUAL_ACCOUNT"` | May not have a naira account yet (`eligible: false`) | Show `reason` (step 8) |
| 202 | `status: "PENDING"` (naira account) | The account is being opened | Show "Setting up…" and ask again in a few seconds (step 8) |
| 409 | | Already in progress (e.g. a second Advanced submission) | Show `message` |
| 429 | `Retry-After` header | Too many requests | Wait that many seconds. **Never auto-retry sign-in, sign-up, reset or password change.** |
| 503 | `maintenance` or a provider is down | Temporarily unavailable | Show `message`, try later |

**Never retry a money request with a new `Idempotency-Key`.** Retry with the **same** one.

---

## 6. Testing on your own computer

### 6.1 Switches in `api/.env`

| Setting | For testing | What it does |
|---|---|---|
| `DOJAH_USE_MOCK=true` | Yes | Pretend Dojah, so the `333…` BVNs work |
| `KYC_BASIC_ENABLED=true` | Yes | Without it, `POST /kyc/basic` answers `503 "Verification is not available yet."` |
| `KYC_ADVANCED_ENABLED=true` | For step 17 | Advanced verification on |
| `QUIDAX_USE_MOCK=true` | Yes | Pretend Quidax (addresses like `mock_usdt_…`) |
| `PAYREP_USE_MOCK=true` | Yes | Pretend Payrep, plus the deposit simulator (step 9) |
| `NGN_DEPOSITS_ENABLED=true` | Yes | Naira accounts on |
| `EMAIL_VERIFICATION_REQUIRED` | Leave `true` | Customers must confirm their email (step 5) |

Restart the API after changing them. **Easier:** `npm run start:e2e` starts the API with all of these switched on, without touching `.env`.

### 6.2 Things an admin must switch on for a full test

On a fresh database, some money actions are closed until an admin opens them in the dashboard:

- **System → Verification levels:** naira deposit and withdrawal limits start at ₦0. Raise them for the Basic level, or a ₦200,000 deposit is held and withdrawals are refused.
- **System → Withdrawals:** switch naira payouts on (`payoutAvailable` in step 14).
- **Gift cards → Catalogue:** add at least one card type.
- **System → Dojah:** switch Basic (and Advanced) on, as an alternative to the `.env` settings.

### 6.3 The email code on your computer

If SMTP is set in `.env`, the code arrives by email, so register with an inbox you can open. Without email, set a known code (development only):
```
cd api
node scripts/dev-verify-email.mjs --email ada.obi@example.com --set-code 424242
```
Then send `{ "code": "424242" }` to `POST /v1/auth/email/verify`.

### 6.4 Test values that always work (pretend providers)

| What | Value |
|---|---|
| BVN or NIN that verifies | `333` + any 8 digits, with first name `Someone`, last name `Clean`, date of birth `1995-03-03` |
| Bank for withdrawals | Pick from `GET /v1/withdrawals/ngn/banks`; any 10-digit account number, named `MOCK ACCOUNT <last 4>` |
| An ERC-20 address that passes the format check | `0x52908400098527886E0F7030069857D2E4169EE7` |
| Naira payout outcomes | The last two digits of the amount pick the outcome: `.51` refused, `.99` answer lost but paid, `.98` status unknown (see `Reports/PAYREP_PAYMENT_TESTING_GUIDE.md`) |

### 6.5 Running the whole journey in Postman

1. **Import** `api/docs/postman/DavoChain-Customer-Journey.postman_collection.json` (Postman → Import → choose the file).
2. Open the collection → **Variables** tab. Set:
   - `baseUrl`: `http://localhost:3000` (no `/v1`);
   - `email`: an inbox you can open (the code is emailed);
   - `phone`: a number no other account uses;
   - `bvn`: `333` + 8 new digits for each new tester;
   - `adminEmail` and `adminPassword`: a local admin, for the "admin, local test only" helpers.
   Save.
3. Run the folders **in order, top to bottom**:
   - **0. Setup:** admin log in, once.
   - **2. Account › Register**, then put the emailed code in `emailCode` and run **3. Confirm the email › Confirm with the code**.
   - **4. Basic verification**, then **2. Account › Log in again** (approval ends the session).
   - **5. Naira account number:** "Get my naira account" (it opens by itself, no BVN), then **Simulate a ₦200,000 bank transfer in**.
   - Then folders **6 to 15**. The gift-card approval helper sits inside folder 11. For folder 12, choose a picture in each upload's Body › form-data.
4. IDs flow from one request to the next by themselves (`quoteId`, `savedBankAccountId`, `giftcardTradeId`, …). Tokens refresh by themselves (section 2.6).
5. Open **View → Show Postman Console** to see the messages ("Access token refreshed automatically", "Sign in again", "Verified!").

For the live server, change `baseUrl` and use real details. The "admin, local test only" requests answer 404 there.

### 6.6 Swagger

With the server running outside production, `http://localhost:3000/docs` lists every endpoint and lets you try them in the browser.

---

## 7. Endpoint index

**Public** = no token. **Email** = needs a confirmed email. **Level** = the admin's level rules decide (step 7). **Key** = needs `Idempotency-Key`.

| Method | Path | Notes | Step |
|---|---|---|---|
| GET | `/health` | Public, no `/v1` | 1 |
| GET | `/v1/site` | Public | 1 |
| GET | `/v1/assets`, `/v1/assets/:code/networks?purpose=` | Public | 1 |
| GET | `/v1/kyc/states` | Public | 1 |
| GET | `/v1/content/pages`, `/v1/content/pages/:slug`, `/v1/content/faqs` | Public | 1 |
| POST | `/v1/auth/register` | Public | 2 |
| POST | `/v1/auth/login` | Public | 3 |
| POST | `/v1/auth/refresh` | Public | 2.3 |
| GET | `/v1/auth/me`, `/v1/me` | | 4 |
| POST | `/v1/auth/email/send-code`, `/v1/auth/email/verify` | | 5 |
| GET | `/v1/kyc` | | 6 |
| POST | `/v1/kyc/basic` | Email | 6 |
| GET | `/v1/me/level` | | 7 |
| GET/POST | `/v1/deposits/ngn/account` | GET opens it if needed; POST: email, no body | 8 |
| GET | `/v1/wallets` | | 9 |
| GET | `/v1/deposits?limit=` | | 9 |
| POST | `/v1/deposits/address` | Email, Level | 10 |
| GET | `/v1/deposits/addresses` | | 10 |
| POST | `/v1/quotes` | Email, Level | 11–13 |
| POST | `/v1/trades` | Email, Level, Key | 11–13 |
| GET | `/v1/trades?limit=`, `/v1/trades/:id` | | 11–13 |
| GET | `/v1/withdrawals/ngn/banks` | | 14 |
| POST | `/v1/withdrawals/ngn/verify-account` | Level | 14 |
| GET | `/v1/withdrawals/quote/ngn?amount=` | | 14 |
| GET/POST/DELETE | `/v1/me/bank-accounts`, `/v1/me/bank-accounts/:id` | POST: password, Level | 14 |
| POST | `/v1/withdrawals/ngn` | Email, Level, Key | 14 |
| GET | `/v1/withdrawals/quote?asset=&network=&amount=` | | 15 |
| GET/POST/DELETE | `/v1/me/crypto-addresses`, `/v1/me/crypto-addresses/:id` | POST: password, Level | 15 |
| POST | `/v1/withdrawals/crypto` | Email, Level, Key | 15 |
| GET | `/v1/withdrawals?limit=` | | 14–15 |
| GET | `/v1/giftcards/catalogue` | Public | 16 |
| POST | `/v1/giftcards/trades` | Email, Level | 16 |
| GET | `/v1/giftcards/trades`, `/v1/giftcards/trades/:id`, `/v1/giftcards/trades/:id/images/:imageId` | | 16 |
| POST | `/v1/kyc/documents` | multipart | 17 |
| POST | `/v1/kyc/advanced/identity`, `/v1/kyc/advanced/address` | | 17 |
| GET | `/v1/notifications?limit=` | | 18 |
| POST | `/v1/notifications/read` | | 18 |
| GET/POST/DELETE | `/v1/devices` | | 18 |
| GET | `/v1/referrals/me`, `/v1/referrals/code/:code` (Public) | | 19 |
| PUT | `/v1/referrals/username` | | 19 |
| POST | `/v1/auth/change-password` | | 20 |
| POST | `/v1/auth/reset/request`, `/v1/auth/reset/confirm` | Public | 20 |
| POST | `/v1/auth/logout` | | 21 |

The full list of all 231 routes (admin included), with every field rule, is [`ROUTE_INVENTORY.md`](ROUTE_INVENTORY.md).
