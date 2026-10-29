# Transaction PIN and sending money — guide for the app

**For:** the Flutter developer. **Since:** 29 October 2026.

This guide covers two things:

1. **How to send a request the server can read.** Headers, body and examples for a send by username. Read this first: it is why the first username sends failed.
2. **The transaction PIN.** A 4-digit PIN the customer types before money leaves their wallet or a swap runs: creating it, sending it, wrong tries, changing it and "Forgot PIN".

All paths start with `/v1`. On your local server that is `http://localhost:3000/v1/...`.

---

## Contents

1. [Why the first username send failed](#1-why-the-first-username-send-failed)
2. [The rules every request follows](#2-the-rules-every-request-follows)
3. [Sending crypto by username, step by step](#3-sending-crypto-by-username-step-by-step)
4. [The transaction PIN: what the customer sees](#4-the-transaction-pin-what-the-customer-sees)
5. [PIN endpoints](#5-pin-endpoints)
6. [Which requests need the PIN](#6-which-requests-need-the-pin)
7. [PIN errors and what the app should do](#7-pin-errors-and-what-the-app-should-do)
8. [Dart examples](#8-dart-examples)
9. [Testing checklist](#9-testing-checklist)
10. [What changed on 29 October 2026](#10-what-changed-on-29-october-2026)

---

## 1. Why the first username send failed

On 29 October at 08:57 the app called `POST /v1/transfers/crypto`. The server answered:

```json
{
  "message": [
    "username must be shorter than or equal to 64 characters",
    "username must be a string",
    "asset must be shorter than or equal to 20 characters",
    "asset must be a string",
    "Enter an amount greater than zero"
  ],
  "error": "Bad Request",
  "statusCode": 400
}
```

That means **the body reached the server empty**. The server refuses any field it does not know, and it did not complain about one, so no fields arrived at all.

The usual cause is a body sent **without** the header `Content-Type: application/json`. For example:

```dart
// ❌ The body goes out as plain text. The server sees nothing.
http.post(url, headers: {'Authorization': 'Bearer $token'}, body: jsonEncode(data));

// ❌ Form data instead of JSON.
dio.post(path, data: FormData.fromMap(data));
```

The fix is to send JSON and say so:

```dart
// ✅
http.post(url,
  headers: {
    'Authorization': 'Bearer $token',
    'Content-Type': 'application/json',
    'Idempotency-Key': const Uuid().v4(),
    'X-Transaction-Pin': pin,
  },
  body: jsonEncode({'username': 'ada_4821', 'asset': 'usdt', 'amount': '5'}),
);
```

With Dio, pass a `Map` as `data` (not `FormData`). Dio then sends JSON with the right header itself.

---

## 2. The rules every request follows

| Rule | What it means |
| --- | --- |
| **JSON body** | Every `POST` and `PUT` body is a JSON **object** with `Content-Type: application/json`. |
| **Exact field names** | Field names are case-sensitive: `username`, not `userName` or `recipient`. An unknown field is refused with `400 "property X should not exist"`. |
| **Amounts are strings** | Send `"amount": "5"` or `"amount": "0.0025"`, never a number (`5`). Numbers lose digits in crypto amounts. |
| **Signed in** | `Authorization: Bearer <accessToken>` on every request in this guide. |
| **Idempotency-Key on money requests** | A new random UUID for each **tap** of the Send button. If the network drops and you retry the same tap, send the **same** key: the server then returns the first answer and never sends twice. |
| **PIN on money requests** | `X-Transaction-Pin: 1234` (the customer's 4 digits) on the requests in [section 6](#6-which-requests-need-the-pin). |
| **Errors carry a `code`** | Most refusals look like `{ "code": "PIN_WRONG", "message": "…" }`. Decide what to do from `code`, and show `message` to the customer: it is written for them. |
| **401 means signed out** | The server answers **401** only when the session token is missing or expired. A wrong PIN or wrong password is **403**, so it never signs the customer out. |

---

## 3. Sending crypto by username, step by step

### Step 1 — Find the person (as they finish typing)

```http
GET /v1/transfers/recipient?username=ada_4821
Authorization: Bearer eyJhbGciOi…
```

The `@` is optional (`@ada_4821` works too), and capital letters do not matter.

**Success `200`**

```json
{ "username": "ada_4821", "displayName": "Ada O.", "canReceive": true, "reason": null }
```

Show **"Ada O."** so the customer can check they have the right person.

If `canReceive` is `false`, show `reason` and keep the Send button off:

```json
{ "username": "ada_4821", "displayName": "Ada O.", "canReceive": false, "reason": "They have not finished Basic verification yet, so they cannot receive coins." }
```

**Not found `404`**

```json
{ "code": "USERNAME_NOT_FOUND", "message": "No DavoChain customer has that username. Check the spelling." }
```

Look-ups are limited to **30 per 10 minutes**, so look up after the customer stops typing, not on every key.

### Step 2 — Ask for the PIN

When they tap **Send**, show the 4-digit PIN pad. If `GET /v1/me` says `"hasTransactionPin": false`, send them to **Create your PIN** first ([section 4](#4-the-transaction-pin-what-the-customer-sees)).

### Step 3 — Send

**Headers**

| Header | Required | Value |
| --- | --- | --- |
| `Authorization` | ✅ | `Bearer <accessToken>` |
| `Content-Type` | ✅ | `application/json` |
| `Idempotency-Key` | ✅ | A new UUID per tap; the same one if you retry that tap |
| `X-Transaction-Pin` | ✅ | The 4 digits the customer typed, e.g. `4826` |

**Body**

| Field | Type | Required | Rules | Example |
| --- | --- | --- | --- | --- |
| `username` | string | ✅ | The receiver's payment username. A leading `@` is fine | `"ada_4821"` |
| `asset` | string | ✅ | The coin code, small or capital letters. Naira cannot be sent this way | `"usdt"` |
| `amount` | string | ✅ | A positive number **as a string**: what the receiver gets. There is no fee | `"5"` |

**The full request**

```http
POST /v1/transfers/crypto
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json
Idempotency-Key: 6f1c2b7e-3d4a-4e8b-9c0f-1a2b3c4d5e6f
X-Transaction-Pin: 4826

{
  "username": "ada_4821",
  "asset": "usdt",
  "amount": "5"
}
```

**Success `201`**

```json
{
  "transactionId": "e4b2d8f1-3a6c-4e9b-b7d2-1c5f8a0e6d39",
  "status": "COMPLETED",
  "asset": "usdt",
  "amount": "5.000000",
  "toDavoChainCustomer": true,
  "to": { "username": "ada_4821", "displayName": "Ada O." }
}
```

- It is **free and instant**. The sender's balance goes down by exactly `amount`, and the receiver has it straight away. They also get a push and an email: "Alice S. sent you 5 USDT".
- `status` is almost always `COMPLETED`. Very rarely it is `RECONCILING`, which means the server is confirming with the exchange. Nothing is lost; it finishes by itself. Show "Processing" and refresh `GET /v1/trades/{transactionId}` (`FLUTTER_API.md` 7.4), or wait for the push.
- In the histories, the sender's withdrawal has `to: { username, displayName }` and the receiver's deposit has `from: { displayName }`.

### Step 4 — Handle a refusal

| Status | `code` or `message` | What happened | What the app does |
| --- | --- | --- | --- |
| 400 | `message` is a **list** ("username must be a string" …) | The body was empty, not JSON, or a field was missing | A bug in the app: check [section 2](#2-the-rules-every-request-follows) |
| 400 | "property X should not exist" | An unknown field was sent | Remove that field |
| 400 | "Idempotency-Key header is required for this request" | No `Idempotency-Key` | Add it |
| 403 | `PIN_NOT_SET` / `PIN_REQUIRED` / `PIN_WRONG` / `PIN_LOCKED` | PIN problem | See [section 7](#7-pin-errors-and-what-the-app-should-do) |
| 404 | `USERNAME_NOT_FOUND` | No such username | Show `message` |
| 400 | `OWN_ADDRESS` | Sending to themselves | Show `message` |
| 400 | `RECIPIENT_NOT_VERIFIED` | The receiver has not finished Basic verification | Show `message` |
| 400 | `RECIPIENT_CANNOT_RECEIVE` | The receiver's account is suspended | Show `message` |
| 400 | "Insufficient USDT balance: …" | Not enough money | Show `message` |
| 400 | "Only crypto can be sent by username." | `asset` was `ngn` | Hide naira from this screen |
| 403 | `COOLING_OFF` (with `until`) | A safety wait is on, e.g. just after a password or PIN reset | Show `message`; it says when sending opens |
| 403 | `EMAIL_NOT_VERIFIED`, level errors | Not allowed yet | As for a crypto withdrawal (`FLUTTER_API.md` 8.2) |
| 409 | "This Idempotency-Key was already used with a different request" | A key was reused for a different send | Make a new key for each tap |
| 503 | Maintenance | Sending is paused by the team | Show `message` |

A refusal **never takes money**. After a `PIN_WRONG`, let the customer type the PIN again and send with a **new** `Idempotency-Key`.

---

## 4. The transaction PIN: what the customer sees

1. **No PIN yet.** `GET /v1/me` shows `"hasTransactionPin": false`. Before the first send, withdrawal or swap, show **Create your PIN**: their account password and a 4-digit PIN, typed twice. (The "typed twice" check happens in the app; the server gets the PIN once.)
2. **Using it.** Every send, withdrawal and swap asks for the 4 digits. Getting a price does not.
3. **Wrong PIN.** "Wrong PIN. 3 tries left." After **5 wrong in a row**, the PIN locks for **30 minutes**, and we email the customer. A right PIN resets the count.
4. **Change PIN** (Settings): the old PIN, then the new one.
5. **Forgot PIN** (Settings, or from the lock message):
   1. They enter their **password**.
   2. We email a **6-digit code**.
   3. They enter the code and a new PIN.

   This also unlocks a locked PIN. For safety, **sends and withdrawals then wait a while** (24 hours by default, the same as after a password change). Swaps keep working, because the money stays in their wallet.
6. **Easy PINs are refused:** the same digit four times (`0000`), a straight run (`1234`, `4321`, `0123`), two pairs (`1212`, `1122`) and a few very common ones (`2580`, `1004`, `2000`).

Every time a PIN is created, changed or reset, the customer gets a security email.

---

## 5. PIN endpoints

None of these needs the `X-Transaction-Pin` header. They all need `Authorization` and, for bodies, `Content-Type: application/json`.

| What | Method and path | Body | Success |
| --- | --- | --- | --- |
| Status | `GET /v1/me/transaction-pin` | — | `200` |
| Create | `POST /v1/me/transaction-pin` | `{ "password", "pin" }` | `201` |
| Change | `PUT /v1/me/transaction-pin` | `{ "currentPin", "newPin" }` | `200` |
| Forgot PIN, step 1 | `POST /v1/me/transaction-pin/reset/request` | `{ "password" }` | `200` |
| Forgot PIN, step 2 | `POST /v1/me/transaction-pin/reset` | `{ "code", "newPin" }` | `200` |

Create, change and both reset steps are limited to **10 per 15 minutes** (`429` after that).

### 5.1 Status

```http
GET /v1/me/transaction-pin
Authorization: Bearer eyJhbGciOi…
```

**`200`**

```json
{ "isSet": true, "setAt": "2026-10-29T09:12:44.120Z", "lockedUntil": null, "triesLeft": 5 }
```

| Field | Meaning |
| --- | --- |
| `isSet` | `false`: show **Create your PIN** |
| `setAt` | When it was created or last changed |
| `lockedUntil` | Set while it is locked; show "Try again after …" and offer **Forgot PIN** |
| `triesLeft` | Wrong tries left before it locks (5 after a right PIN) |

`GET /v1/me` also has `"hasTransactionPin": true | false`, so the home screen does not need this extra call.

### 5.2 Create

```http
POST /v1/me/transaction-pin
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json

{ "password": "the-account-password", "pin": "4826" }
```

| Field | Type | Rules |
| --- | --- | --- |
| `password` | string | Their account password (stops someone holding an unlocked phone from making a PIN) |
| `pin` | string | Exactly 4 digits, **as a string** (`"0482"` keeps its leading zero), not easy to guess |

**`201`**

```json
{ "isSet": true, "setAt": "2026-10-29T09:12:44.120Z", "lockedUntil": null, "triesLeft": 5 }
```

**Refusals**

```json
// 403: wrong password (counted like a failed sign-in)
{ "code": "PASSWORD_WRONG", "message": "Incorrect password" }

// 400: not 4 digits
{ "code": "PIN_WEAK", "message": "Your PIN must be exactly 4 digits." }

// 400: too easy
{ "code": "PIN_WEAK", "message": "That PIN is too easy to guess. Choose 4 digits that are not in a row or repeated." }

// 409: they already have one (use Change or Forgot PIN)
{ "code": "PIN_ALREADY_SET", "message": "You already have a transaction PIN. Change it or reset it instead." }
```

### 5.3 Change

```http
PUT /v1/me/transaction-pin
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json

{ "currentPin": "4826", "newPin": "7391" }
```

**`200`**: same shape as 5.1.

**Refusals**

- A wrong `currentPin` is `PIN_WRONG` and **counts toward the lock**, exactly like a wrong PIN on a send.
- `PIN_LOCKED` if it is locked.
- `PIN_WEAK` for an easy new PIN.
- `400 { "code": "PIN_SAME", "message": "Your new PIN must be different from the old one." }`.

### 5.4 Forgot PIN, step 1: send the code

```http
POST /v1/me/transaction-pin/reset/request
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json

{ "password": "the-account-password" }
```

**`200`**

```json
{ "sent": true }
```

A 6-digit code goes to their email. It lasts **10 minutes**. Asking again within a minute does not send another (the answer is still `200`). A wrong password is `403 PASSWORD_WRONG`, and no code is sent.

### 5.5 Forgot PIN, step 2: new PIN

```http
POST /v1/me/transaction-pin/reset
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json

{ "code": "135790", "newPin": "5173" }
```

**`200`**

```json
{ "isSet": true, "setAt": "2026-10-29T09:40:02.511Z", "lockedUntil": null, "triesLeft": 5 }
```

**Refusals (`400`)**

- "That code is not right. 4 tries left."
- "That code has expired. Ask for a new one."
- "Too many wrong codes. Ask for a new one."
- `PIN_WEAK`

`403 PIN_NOT_SET` means they never had a PIN: use Create instead.

**After a reset:** sends and withdrawals answer `403 COOLING_OFF` until the wait ends. The `message` says when, e.g. "Withdrawals open at 30 Oct, 09:40, …". Swaps work at once.

---

## 6. Which requests need the PIN

Add `X-Transaction-Pin: <4 digits>` to these four, and only these:

| Request | What it is | Guide |
| --- | --- | --- |
| `POST /v1/transfers/crypto` | Send crypto by username | [section 3](#3-sending-crypto-by-username-step-by-step) |
| `POST /v1/withdrawals/crypto` | Send crypto to a wallet address (DavoChain or outside) | `FLUTTER_API.md` 8.2 |
| `POST /v1/withdrawals/ngn` | Naira to a bank account | `FLUTTER_API.md` 8.7 |
| `POST /v1/trades` | Place a buy, sell or swap | `FLUTTER_API.md` 7.2 |

**Not** these: getting a price (`POST /v1/quotes`), fee quotes, saving a bank account or address (those ask for the password), deposits or gift-card sales.

**Example: a swap**

```http
POST /v1/trades
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json
Idempotency-Key: 3b8f1c2e-6a4d-4f7b-9c1e-2d5a8b7f0e13
X-Transaction-Pin: 4826

{ "quoteId": "5f0e2c1a-8d3b-4c6e-9f21-7a4b3c2d1e0f" }
```

**Example: a crypto withdrawal**

```http
POST /v1/withdrawals/crypto
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json
Idempotency-Key: 9d2c4e1a-7b3f-4a8e-b6d1-0f5c2e9a8b47
X-Transaction-Pin: 4826

{ "amount": "100", "savedCryptoAddressId": "6c0f2b1e-8a4d-4f3c-9e7a-2d5b1c8f0a64" }
```

**Example: a naira withdrawal**

```http
POST /v1/withdrawals/ngn
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json
Idempotency-Key: 1c7e9a2b-4d6f-4b8a-9e3c-5f1a2d7b8c90
X-Transaction-Pin: 4826

{ "amount": "25000", "savedBankAccountId": "a3d9c1e7-2b4f-4c8a-9d6e-7f0b1a2c3d45" }
```

The success replies are unchanged; see `FLUTTER_API.md` 7.2, 8.2 and 8.7.

**A quote lasts 12 seconds.** Show the PIN pad **before** you get the price, or get a new quote after the PIN is typed, so the quote has not run out by the time the trade is placed.

**The PIN is checked first.** It is checked before the body, so a wrong PIN answers `PIN_WRONG` even if the body has a mistake. A right PIN then goes on to the usual checks.

---

## 7. PIN errors and what the app should do

All are **403** with a `code`. None of them takes money or signs the customer out.

| `code` | Reply | What the app does |
| --- | --- | --- |
| `PIN_NOT_SET` | `{ "code": "PIN_NOT_SET", "message": "Create a transaction PIN first." }` | Open **Create your PIN**, then come back to this screen |
| `PIN_REQUIRED` | `{ "code": "PIN_REQUIRED", "message": "Enter your transaction PIN." }` | The header was missing: show the PIN pad (an app bug if it happens after the pad) |
| `PIN_WRONG` | `{ "code": "PIN_WRONG", "triesLeft": 3, "message": "Wrong PIN. 3 tries left." }` | Clear the pad, show `message`, let them try again (with a **new** Idempotency-Key) |
| `PIN_LOCKED` | `{ "code": "PIN_LOCKED", "until": "2026-10-29T10:30:00.000Z", "message": "Too many wrong PINs. Try again after 29 October 2026 at 10:30 WAT, or reset your PIN." }` | Show `message` with a **Forgot PIN** button. Do not show the pad again until `until` |
| `PASSWORD_WRONG` | `{ "code": "PASSWORD_WRONG", "message": "Incorrect password" }` | On Create or Forgot PIN: show `message`. Many wrong passwords lock sign-in, as on the sign-in screen |

---

## 8. Dart examples

Below, `api` is a `Dio` with `baseUrl: 'https://<server>/v1'` and the `Authorization` header already added by your interceptor.

```dart
import 'package:dio/dio.dart';
import 'package:uuid/uuid.dart';

/// One tap of Send = one key. Keep it while retrying that same tap.
final String sendKey = const Uuid().v4();

Future<Map<String, dynamic>> sendByUsername({
  required String username,
  required String asset,
  required String amount, // a String, e.g. '5' or '0.0025'
  required String pin,    // the 4 digits typed
  required String idempotencyKey,
}) async {
  final res = await api.post(
    '/transfers/crypto',
    data: {'username': username, 'asset': asset, 'amount': amount}, // a Map → sent as JSON
    options: Options(headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'X-Transaction-Pin': pin,
    }),
  );
  return res.data as Map<String, dynamic>; // 201
}

/// What to do with a refusal. `e.response?.data` is the JSON body.
void handleSendError(DioException e) {
  final status = e.response?.statusCode;
  final body = e.response?.data;
  final code = body is Map ? body['code'] as String? : null;
  final message = body is Map ? body['message'] : null;

  switch (code) {
    case 'PIN_NOT_SET':
      // open the Create PIN screen
      break;
    case 'PIN_WRONG':
      // show message ("Wrong PIN. 3 tries left."), clear the pad, make a NEW key
      break;
    case 'PIN_LOCKED':
      // show message + Forgot PIN button; body['until'] is when it unlocks
      break;
    case 'COOLING_OFF':
      // show message; it says when sending opens
      break;
    default:
      if (status == 400 && message is List) {
        // validation failed: an app bug, log it ("username must be a string" = empty body)
      } else {
        // show message as it is
      }
  }
}

Future<void> createPin(String password, String pin) =>
    api.post('/me/transaction-pin', data: {'password': password, 'pin': pin});

Future<void> changePin(String currentPin, String newPin) =>
    api.put('/me/transaction-pin', data: {'currentPin': currentPin, 'newPin': newPin});

Future<void> forgotPinSendCode(String password) =>
    api.post('/me/transaction-pin/reset/request', data: {'password': password});

Future<void> forgotPinSetNew(String code, String newPin) =>
    api.post('/me/transaction-pin/reset', data: {'code': code, 'newPin': newPin});
```

With the `http` package instead of Dio, always add `'Content-Type': 'application/json'` and `jsonEncode` the body ([section 1](#1-why-the-first-username-send-failed)).

**Keep the PIN safe in the app:**

- Never store it, log it or put it in analytics or crash reports.
- Clear it from memory after the request.
- Don't put it in the URL.

---

## 9. Testing checklist

1. Sign in with a verified (Basic) account. `GET /v1/me` → `hasTransactionPin: false`.
2. Try a send → `403 PIN_NOT_SET`.
3. Create a PIN with `1234` → `400 PIN_WEAK`. With `4826` and the right password → `201`.
4. Send by username without the header → `403 PIN_REQUIRED`.
5. Send with the right PIN → `201 COMPLETED`, and the receiver's balance goes up.
6. Send with a wrong PIN 4 times → `PIN_WRONG` with `triesLeft` 4, 3, 2, 1. The 5th → `PIN_LOCKED`, and the email arrives.
7. Forgot PIN → code by email → new PIN → `200`. A send now answers `COOLING_OFF`; a swap works.

**No real inbox on the test server?** The team can set a known code:

```
node scripts/dev-verify-email.mjs --email <their email> --purpose PIN_RESET --set-code 135790
```

An owner can also unlock a locked PIN on the dashboard (People → Users → the customer → **Unlock PIN**).

---

## 10. What changed on 29 October 2026

| Change | What the app must do |
| --- | --- |
| New: transaction PIN | Build Create / Change / Forgot PIN screens ([section 5](#5-pin-endpoints)) |
| `X-Transaction-Pin` header on 4 requests | Add it ([section 6](#6-which-requests-need-the-pin)) |
| `GET /v1/me` has `hasTransactionPin` | Use it to show **Create your PIN** |
| The password on a first send of ₦100,000 or more is **gone** | Drop that screen. `PASSWORD_REQUIRED` no longer happens. An old app that still sends `password` is not refused; it is ignored |
| Wrong password on a PIN screen is **403**, not 401 | Do not sign the customer out on it |
