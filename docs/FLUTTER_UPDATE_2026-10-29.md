# App update — 29 October 2026

**For:** the Flutter developer.
**What this is:** the changes made to the server today, and exactly what the app needs to do for each one. Every request and reply below is real. The longer guides are linked for when you need more detail.

| # | Change | What the app must do | Full guide |
| --- | --- | --- | --- |
| 1 | **Fix:** why "send by username" did not work | Send the body as JSON with `Content-Type: application/json` | [TRANSACTION_PIN.md §1–3](TRANSACTION_PIN.md) |
| 2 | **New:** 4-digit transaction PIN | PIN screens + a header on 4 requests | [TRANSACTION_PIN.md](TRANSACTION_PIN.md) |
| 3 | **New:** profile photo | Upload / show / delete screens | [PROFILE_PHOTO.md](PROFILE_PHOTO.md) |
| 4 | **Changed:** `GET /v1/me` and the username lookup | Read two new fields | below |
| 5 | **Removed:** password on a first send of ₦100,000 or more | Delete that screen | below |

---

## 1. Fix: why "send by username" did not work

### What happened

Your test send this morning reached the server **with an empty body**. The server answered:

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

A list of "must be a string" messages for **every** field means none of the fields arrived. The server code is working. The request was not being read as JSON.

### The cause

The body was sent **without** `Content-Type: application/json`, or as form data. For example:

```dart
// ❌ Goes out as plain text: the server sees an empty body.
http.post(url, headers: {'Authorization': 'Bearer $token'}, body: jsonEncode(data));
```

### The fix

```dart
// ✅ http package
http.post(url,
  headers: {
    'Authorization': 'Bearer $token',
    'Content-Type': 'application/json',
    'Idempotency-Key': const Uuid().v4(),
    'X-Transaction-Pin': pin,
  },
  body: jsonEncode({'username': 'ada_4821', 'asset': 'usdt', 'amount': '5'}),
);

// ✅ Dio: pass a Map (NOT FormData). Dio sends JSON with the right header.
api.post('/transfers/crypto',
  data: {'username': 'ada_4821', 'asset': 'usdt', 'amount': '5'},
  options: Options(headers: {'Idempotency-Key': key, 'X-Transaction-Pin': pin}),
);
```

### The complete request that works

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

| Header | Required | Notes |
| --- | --- | --- |
| `Authorization` | ✅ | `Bearer <accessToken>` |
| `Content-Type` | ✅ | `application/json` — **this was missing** |
| `Idempotency-Key` | ✅ | A new UUID for each tap of Send; the **same** one if you retry that tap after a network error |
| `X-Transaction-Pin` | ✅ | **New today** — the customer's 4-digit PIN (section 2) |

| Body field | Type | Notes |
| --- | --- | --- |
| `username` | string | Their payment username. A leading `@` is fine; capital letters don't matter |
| `asset` | string | Coin code, e.g. `"usdt"`, `"btc"`. Not naira |
| `amount` | **string** | `"5"`, not `5`. What the receiver gets; there is no fee |

Only these three fields. Any other field (e.g. `recipient`, `userName`) is refused with `400 "property X should not exist"`.

**Success `201`:**

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

Every refusal and what to show is in [TRANSACTION_PIN.md §3 step 4](TRANSACTION_PIN.md#step-4--handle-a-refusal).

### The same rule everywhere

**Every** `POST` and `PUT` in the API takes JSON with `Content-Type: application/json`. The one exception is file uploads (KYC documents, gift-card photos and the new profile photo), which are `multipart/form-data`. If an endpoint ever answers with "must be a string" for every field, the body did not arrive as JSON.

---

## 2. New: 4-digit transaction PIN

Before money leaves the wallet, or a swap runs, the customer types a 4-digit PIN.

### What to build

1. **Create your PIN** screen. Show it when `GET /v1/me` has `"hasTransactionPin": false`, before the first send, withdrawal, buy, sell or swap. It needs:
   - their account password;
   - a 4-digit PIN, typed twice. The app checks the two match.
2. **PIN pad** before each of the 4 requests below.
3. **Change PIN** in Settings: the old PIN, then a new one.
4. **Forgot PIN**: password → a 6-digit code arrives by email → code + new PIN.

### The 4 requests that now need the header `X-Transaction-Pin`

| Request | What it is |
| --- | --- |
| `POST /v1/transfers/crypto` | Send by username |
| `POST /v1/withdrawals/crypto` | Send crypto to a wallet address |
| `POST /v1/withdrawals/ngn` | Naira to a bank |
| `POST /v1/trades` | Buy, sell or swap |

Getting a price (`POST /v1/quotes`) does **not** need it. A quote lasts 12 seconds, so show the PIN pad **before** getting the price.

### PIN endpoints

All take JSON, with no PIN header.

| What | Request | Body | Success |
| --- | --- | --- | --- |
| Status | `GET /v1/me/transaction-pin` | — | `200 { "isSet": true, "setAt": "…", "lockedUntil": null, "triesLeft": 5 }` |
| Create | `POST /v1/me/transaction-pin` | `{ "password": "…", "pin": "4826" }` | `201`, same shape as status |
| Change | `PUT /v1/me/transaction-pin` | `{ "currentPin": "4826", "newPin": "7391" }` | `200`, same shape |
| Forgot 1 | `POST /v1/me/transaction-pin/reset/request` | `{ "password": "…" }` | `200 { "sent": true }` (code emailed, valid 10 min) |
| Forgot 2 | `POST /v1/me/transaction-pin/reset` | `{ "code": "135790", "newPin": "5173" }` | `200`, same shape as status |

Send the PIN as a **string** (`"0482"` keeps its leading zero).

### PIN replies to handle

All are `403`. None takes money, and none signs the customer out.

| `code` | Example reply | What the app does |
| --- | --- | --- |
| `PIN_NOT_SET` | `{ "code": "PIN_NOT_SET", "message": "Create a transaction PIN first." }` | Open Create your PIN, then come back |
| `PIN_REQUIRED` | `{ "code": "PIN_REQUIRED", "message": "Enter your transaction PIN." }` | The header was missing: show the pad |
| `PIN_WRONG` | `{ "code": "PIN_WRONG", "triesLeft": 3, "message": "Wrong PIN. 3 tries left." }` | Show `message`; let them retry with a **new** Idempotency-Key |
| `PIN_LOCKED` | `{ "code": "PIN_LOCKED", "until": "2026-10-29T10:30:00.000Z", "message": "Too many wrong PINs. Try again after 29 October 2026 at 10:30 WAT, or reset your PIN." }` | Show `message` and a Forgot PIN button |
| `PASSWORD_WRONG` | `{ "code": "PASSWORD_WRONG", "message": "Incorrect password" }` | On Create / Forgot PIN: show `message` |

Other replies when creating or changing a PIN:
- `400 PIN_WEAK` for an easy PIN (`1234`, `0000`, `1212`, `2580` …), with a message to show.
- `409 PIN_ALREADY_SET` when Create is used but a PIN already exists.
- `400 PIN_SAME` when the new PIN is the same as the old one.

**After Forgot PIN**, sends and withdrawals answer `403 COOLING_OFF` for a while (24 hours by default), and the `message` says until when. Swaps work at once.

Everything in more detail, with Dart code: [TRANSACTION_PIN.md](TRANSACTION_PIN.md).

---

## 3. New: profile photo

| What | Request | Success |
| --- | --- | --- |
| Upload or replace | `PUT /v1/me/avatar`, **`multipart/form-data`** with one field named **`file`** (JPEG, PNG or WebP, max 5 MB) | `200 { "avatarUrl": "/v1/avatars/3f9c…", "updatedAt": "…" }` |
| Delete | `DELETE /v1/me/avatar` | `200 { "removed": true }` |
| Show | `GET <baseUrl><avatarUrl>` with the `Authorization` header | the image (WebP, 512×512) |

```dart
// Upload with Dio. Do NOT set Content-Type yourself.
final form = FormData.fromMap({
  'file': await MultipartFile.fromFile(picked.path, filename: 'photo.jpg', contentType: MediaType('image', 'jpeg')),
});
final res = await api.put('/me/avatar', data: form);
final avatarUrl = res.data['avatarUrl'];
```

- The server crops it square from the centre, turns it upright, shrinks it and removes hidden GPS data.
- Every new photo gets a **new** `avatarUrl`, and the old one stops working. So cache by `avatarUrl` forever (`cached_network_image` with `cacheKey: avatarUrl`).
- `avatarUrl: null` means no photo: show the initials.
- iPhone HEIC photos are refused (`400 AVATAR_NOT_IMAGE`). Ask the image picker for JPEG.

| Error | When |
| --- | --- |
| `400 AVATAR_NOT_MULTIPART` | Sent as JSON, or the field isn't called `file` |
| `400 AVATAR_NOT_IMAGE` | Not a JPEG / PNG / WebP picture |
| `413 AVATAR_TOO_LARGE` | Over 5 MB |
| `429` | More than 10 uploads in an hour |

If staff remove an offensive photo, the customer gets an in-app notification (`type: "account.avatar_removed"`) with the reason, and `avatarUrl` becomes `null`.

Everything in more detail, with Dart code: [PROFILE_PHOTO.md](PROFILE_PHOTO.md).

---

## 4. Changed: two replies have new fields

**`GET /v1/me`** has two new fields; the rest is unchanged:

```json
{
  "id": "…",
  "email": "ada@example.com",
  "firstName": "Ada",
  "lastName": "Okafor",
  "payUsername": "ada_4821",
  "hasTransactionPin": true,
  "avatarUrl": "/v1/avatars/3f9c2b7e1d4a4e8b9c0f1a2b3c4d5e6f",
  "emailVerified": true,
  "…": "…"
}
```

| New field | Use it to |
| --- | --- |
| `hasTransactionPin` | Show "Create your PIN" when `false` |
| `avatarUrl` | Show the photo, or initials when `null` |

**`GET /v1/transfers/recipient?username=…`** now includes the receiver's photo:

```json
{ "username": "ada_4821", "displayName": "Ada O.", "avatarUrl": "/v1/avatars/3f9c…", "canReceive": true, "reason": null }
```

Show it next to "Ada O." on the Send screen so the sender knows it's the right person.

---

## 5. Removed: the password on a large first send

Before today, a first send of ₦100,000 or more to someone asked for the account password (`403 PASSWORD_REQUIRED`). The PIN replaces it:
- `PASSWORD_REQUIRED` no longer happens, so remove that screen.
- An older app build that still sends `password` in the body is not refused; the field is ignored.

---

## 6. One-page test checklist

1. `GET /v1/me` → `hasTransactionPin: false`, `avatarUrl: null`.
2. Send by username without a PIN → `403 PIN_NOT_SET`.
3. Create the PIN (`1234` → `PIN_WEAK`; `4826` + password → `201`).
4. Send by username with JSON + `Content-Type` + `Idempotency-Key` + `X-Transaction-Pin` → `201 COMPLETED`.
5. Wrong PIN → `PIN_WRONG` with `triesLeft`. Five wrong → `PIN_LOCKED`, and an email arrives.
6. Buy, swap and withdraw all ask for the PIN.
7. Upload a photo → `avatarUrl`. It shows on the profile and on the other person's username lookup.
8. Replace it → new link, old link `404`. Delete → back to initials.

The Postman collection (`docs/postman/`) has a **3b. Transaction PIN** folder and the PIN header on every money request. Set the `pin` variable once.
