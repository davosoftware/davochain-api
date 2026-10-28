# Payment usernames: guide for the app

**28 October 2026** · For the Flutter app · Base URL `/v1` · Every route here needs `Authorization: Bearer <accessToken>`

Every DavoChain customer has a **payment username**, like `@ada_4821`. Other customers type it to send them crypto (see `FLUTTER_API.md` 8.11 and 8.12). This guide covers how the username is made, how to read it and how to change it.

---

## 1. How it works

| | |
|---|---|
| **Made automatically** | At sign-up, every customer gets `firstname_` plus random digits, e.g. Ada becomes `ada_4821`. The app doesn't need to do anything. |
| **Already signed up** | Customers who signed up before this feature were given one automatically when the server started (and an hourly job catches anyone missed). |
| **Unique** | No two customers can have the same username. Capitals don't matter: `Ada_4821` and `ada_4821` are the same name. It is always stored and returned in **lower case**. |
| **Length** | 7 to 20 characters. |
| **Allowed characters** | Letters `a-z`, numbers `0-9`, underscore `_` and hyphen `-`. **No spaces.** It must contain at least one letter and start and end with a letter or number. |
| **Not allowed** | Names that look official: anything containing `davochain`, `davo`, `admin`, `support`, `official`, `staff`, `helpdesk`, `quidax`, `payrep`, `dojah`, `system` or `security`. |
| **Changing it** | The generated name can be changed **straight away**. After the customer has chosen their own, they can change it again **once every 30 days**. |
| **Old names** | A name someone stops using is kept from everyone else for 30 days, so nobody can take it and receive coins meant for the previous owner. |
| **The `@`** | Show it with an `@` in the app (`@ada_4821`). The API never stores the `@`. If the app sends one, it is ignored. |

How the generated name is made:
- The first name in lower case, with accents removed (`Chiamaká` becomes `chiamaka`) and anything that isn't a letter or number dropped.
- Then `_` and 4 random digits. A very short first name gets more digits so the total is at least 7 (`Jo` becomes `jo_1234`), and a long one is cut so the total is at most 20.
- If nothing usable is left, or the name looks official, `user` is used instead (`user_5530`).

> This is **not** the referral code (`PUT /v1/referrals/username`, `FLUTTER_API.md` 10.3). They are separate.

---

## 2. Get the username

There are two ways.

### 2a. From the profile

`GET /v1/me` includes it:

```json
{
  "id": "6c0f…",
  "email": "ada@example.com",
  "firstName": "Ada",
  "lastName": "Okafor",
  "payUsername": "ada_4821",
  "…": "…"
}
```

### 2b. With the details for the "Edit username" screen

**`GET /v1/me/pay-username`** · **Success:** `200`

```json
{ "payUsername": "ada_4821", "chosenByYou": false, "canChangeFrom": null }
```

| Field | Type | Meaning |
|---|---|---|
| `payUsername` | string \| null | The current username, lower case, without `@`. It is `null` only for a moment after sign-up if something went wrong; the server fills it in within the hour. Show "Setting up…" in that case. |
| `chosenByYou` | boolean | `false`: the name was generated and can be changed right now. `true`: the customer chose it. |
| `canChangeFrom` | string \| null | When the next change is allowed (ISO date-time). `null` means it can be changed now. |

How to use it on the screen:
- `chosenByYou: false`: show "This name was made for you. You can change it."
- `canChangeFrom` set: disable the Edit button and show "You can change your username again on 27 Nov 2026."

---

## 3. Check a name while the customer types

**`GET /v1/me/pay-username/check?username=ada_okafor`** · **Success:** `200`

```json
{ "username": "ada_okafor", "available": true, "reason": null }
```

```json
{ "username": "ada", "available": false, "reason": "A username needs at least 7 characters." }
```

```json
{ "username": "bob_eze_1", "available": false, "reason": "That username is taken." }
```

- `username` is the name as it would be saved (lower case, no `@`). Show it back to the customer.
- Show `reason` exactly as it comes. It's written for the customer.
- **Limit: 30 checks per 10 minutes per customer**, shared with looking people up. After that the API answers `429`. Wait until the customer **stops typing for about half a second** before checking. Don't check on every key press.

---

## 4. Change (edit) the username

**`PUT /v1/me/pay-username`** · **Success:** `200`

```http
PUT /v1/me/pay-username
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json

{ "username": "ada_okafor" }
```

```json
{ "payUsername": "ada_okafor" }
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `username` | string | ✅ | The rules in section 1. A leading `@` and capital letters are fine; it is saved in lower case. |

Errors (all have `code` and `message`; show `message` to the customer):

| Status | `code` | When | Example `message` |
|---|---|---|---|
| 400 | `USERNAME_INVALID` | Breaks a rule | "A username can have no spaces. Use _ or - instead." |
| 409 | `USERNAME_TAKEN` | Someone else has it, or gave it up less than 30 days ago | "That username is taken. Please choose another." |
| 400 | `USERNAME_CHANGE_TOO_SOON` | They chose a name less than 30 days ago. `until` has the date | "You can change your username again from 10:00 on 27 Nov." |

Notes:
- Sending the name they already have changes nothing and still answers `200`.
- After a successful change, `GET /v1/me/pay-username` answers `chosenByYou: true` with a `canChangeFrom` date 30 days ahead.
- Every possible `USERNAME_INVALID` message:
  - "Choose a username first."
  - "A username can have no spaces. Use _ or - instead."
  - "A username can only use letters, numbers, _ and -."
  - "A username needs at least 7 characters."
  - "A username can be at most 20 characters."
  - "A username needs at least one letter."
  - "A username must start and end with a letter or number."
  - "That username looks official. Please choose another."

---

## 5. When an admin removes a username

If a username is offensive, an admin can remove it. The customer immediately gets a **new generated one** and a notification (type `account.pay_username_removed`) such as:

> "We removed @rude_name: Offensive to other customers. Your username is now @ada_7710. You can choose another one."

The new name can be changed straight away (`chosenByYou: false`). The app only needs to refresh `GET /v1/me` when that notification arrives.

---

## 6. Suggested screens

1. **Profile:** show `@payUsername` with a copy button and "Share so friends can send you crypto".
2. **Edit username:**
   - Load `GET /v1/me/pay-username`.
   - If `canChangeFrom` is set, show the date and disable editing.
   - As the customer types, call the check (section 3) after a short pause, and show ✓ or the `reason`.
   - On Save, call `PUT` (section 4) and show any error `message`.
3. **Send crypto:**
   - The customer types a username.
   - Call `GET /v1/transfers/recipient?username=` to show "Ada O.".
   - Then `POST /v1/transfers/crypto` (`FLUTTER_API.md` 8.11 and 8.12).

---

## 7. Quick reference

| What | Method and path | Answer |
|---|---|---|
| Read (with the profile) | `GET /v1/me` | `payUsername` |
| Read (for the edit screen) | `GET /v1/me/pay-username` | `{ payUsername, chosenByYou, canChangeFrom }` |
| Check a name | `GET /v1/me/pay-username/check?username=` | `{ username, available, reason }` |
| Change | `PUT /v1/me/pay-username` `{ username }` | `{ payUsername }` |
| Find someone to send to | `GET /v1/transfers/recipient?username=` | `{ username, displayName, canReceive, reason }` |
| Send to them | `POST /v1/transfers/crypto` | see `FLUTTER_API.md` 8.12 |
