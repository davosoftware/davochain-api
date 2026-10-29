# Profile photo — guide for the app

**For:** the Flutter developer. **Since:** 29 October 2026.

Customers can upload a profile photo, replace it and delete it. The photo shows:
- on their own profile;
- to **senders** who look up their payment username, next to "Ada O.";
- to DavoChain staff on the dashboard.

All paths start with `/v1`. On your local server that is `http://localhost:3000/v1/...`.

---

## Contents

1. [The three calls](#1-the-three-calls)
2. [Upload or replace](#2-upload-or-replace)
3. [Show the photo](#3-show-the-photo)
4. [Delete](#4-delete)
5. [The photo on a username lookup](#5-the-photo-on-a-username-lookup)
6. [When staff remove a photo](#6-when-staff-remove-a-photo)
7. [Errors](#7-errors)
8. [Dart examples](#8-dart-examples)
9. [Testing checklist](#9-testing-checklist)

---

## 1. The three calls

| What | Method and path | Body | Success |
| --- | --- | --- | --- |
| Upload or replace | `PUT /v1/me/avatar` | `multipart/form-data`, one field: `file` | `200` |
| Delete | `DELETE /v1/me/avatar` | none | `200` |
| Get the picture | `GET <avatarUrl>` (e.g. `/v1/avatars/3f9c…`) | none | `200`, an image |

`GET /v1/me` has the link as `avatarUrl` (`null` when there is no photo).

No PIN, no Idempotency-Key. All three need `Authorization: Bearer <accessToken>`.

---

## 2. Upload or replace

**This is the one request that is NOT JSON.** Send the photo as `multipart/form-data`: the same way a browser sends a file from a form.

| Part | Value |
| --- | --- |
| Field name | `file` (exactly this; any other name is refused) |
| File types | JPEG, PNG or WebP (HEIC from an iPhone is **not** accepted: ask the image picker for JPEG) |
| Size | Up to **5 MB** |
| Other fields | None. Only the one file |

Do **not** set `Content-Type` yourself. Your HTTP client sets it to `multipart/form-data; boundary=…` when you send a `FormData` / `MultipartRequest`. Setting it to `application/json` or leaving out the boundary breaks the upload.

**The request** (what goes over the wire):

```http
PUT /v1/me/avatar
Authorization: Bearer eyJhbGciOi…
Content-Type: multipart/form-data; boundary=----dart-boundary-7b1c

------dart-boundary-7b1c
Content-Disposition: form-data; name="file"; filename="photo.jpg"
Content-Type: image/jpeg

<the photo's bytes>
------dart-boundary-7b1c--
```

**Success `200`**

```json
{
  "avatarUrl": "/v1/avatars/3f9c2b7e1d4a4e8b9c0f1a2b3c4d5e6f",
  "updatedAt": "2026-10-29T11:04:12.338Z"
}
```

**What the server does with the photo:**
- Turns it the right way up (phones often save photos sideways).
- Crops it **square from the centre**. If the app has its own cropper, crop to a square first so the customer chooses what is kept.
- Shrinks it to **512 × 512** and saves it as WebP (around 30–60 KB).
- Removes hidden data, such as the GPS location where the photo was taken.

**Replacing** works the same way: just upload again.
- The new photo gets a **new** `avatarUrl`.
- The old link stops working (404).
- Always use the link from the latest reply or from `GET /v1/me`.

Limited to **10 uploads an hour** per customer (`429` after that).

---

## 3. Show the photo

`avatarUrl` is a **path**. Put your API address in front of it, and send the sign-in token:

```
https://api.davochain.com/v1/avatars/3f9c2b7e1d4a4e8b9c0f1a2b3c4d5e6f
Authorization: Bearer eyJhbGciOi…
```

The reply is the picture itself (`Content-Type: image/webp`). Flutter shows WebP natively.

| Situation | What to show |
| --- | --- |
| `avatarUrl` is `null` | The customer's initials in a circle (e.g. "AO") |
| The picture loads | The photo, in a circle |
| `404` | Initials. The photo was changed or removed; refresh `GET /v1/me` |
| `401` | The token expired: refresh it as for any request, then load again |

**Caching:** cache it for as long as you like, keyed by `avatarUrl`. The link changes whenever the photo changes, so a cached photo is never out of date. `cached_network_image` with the `Authorization` header works well (see section 8).

**Only signed-in people can load a photo.** Without a token the answer is `401`. The link never contains the customer's id.

---

## 4. Delete

```http
DELETE /v1/me/avatar
Authorization: Bearer eyJhbGciOi…
```

**`200`**

```json
{ "removed": true }
```

`{ "removed": false }` means there was no photo. That is not an error. Afterwards `GET /v1/me` shows `"avatarUrl": null` and the old link answers `404`.

---

## 5. The photo on a username lookup

`GET /v1/transfers/recipient?username=ada_4821` now also returns `avatarUrl`:

```json
{
  "username": "ada_4821",
  "displayName": "Ada O.",
  "avatarUrl": "/v1/avatars/3f9c2b7e1d4a4e8b9c0f1a2b3c4d5e6f",
  "canReceive": true,
  "reason": null
}
```

Show the photo next to "Ada O." on the Send screen, so the sender can see it is the right person. `null` → initials.

---

## 6. When staff remove a photo

DavoChain staff can remove an offensive photo. When they do:
- The customer's `avatarUrl` becomes `null`.
- The customer gets an in-app notification (`type: "account.avatar_removed"`) with the reason, e.g. "We removed your profile photo: It shows a weapon. You can upload a different one."
- They can upload another photo straight away.

---

## 7. Errors

| Status | `code` | `message` | When |
| --- | --- | --- | --- |
| 400 | `AVATAR_NOT_MULTIPART` | "Send the photo as multipart/form-data with one field: \"file\"." | Sent as JSON, the field is not called `file`, or other fields were added |
| 400 | `AVATAR_NOT_IMAGE` | "Choose a photo: a JPEG, PNG or WebP picture." | Not a picture (checked from the file itself, not its name), a damaged picture, HEIC, or an enormous picture |
| 413 | `AVATAR_TOO_LARGE` | "Your photo must be 5 MB or smaller." | Over 5 MB: shrink it in the app and try again |
| 429 | — | "Too many requests…" | More than 10 uploads in an hour |
| 503 | — | "File storage is unavailable right now. Please try again shortly." | Storage is down: nothing changed, try later |
| 404 | `AVATAR_NOT_FOUND` | "No such photo." | On `GET <avatarUrl>`: the photo was changed or removed |

Show `message` to the customer. It is written for them.

---

## 8. Dart examples

**Upload with Dio** (`api` already adds `Authorization`):

```dart
import 'package:dio/dio.dart';
import 'package:http_parser/http_parser.dart';
import 'package:image_picker/image_picker.dart';

Future<String> uploadAvatar(XFile picked) async {
  final form = FormData.fromMap({
    'file': await MultipartFile.fromFile(
      picked.path,
      filename: 'photo.jpg',
      contentType: MediaType('image', 'jpeg'),
    ),
  });
  // Do NOT set Content-Type: Dio adds multipart/form-data with the boundary.
  final res = await api.put('/me/avatar', data: form);
  return res.data['avatarUrl'] as String;
}

// Pick a JPEG (not HEIC) at a sensible size, so it is well under 5 MB.
final picked = await ImagePicker().pickImage(
  source: ImageSource.gallery,
  maxWidth: 1600,
  maxHeight: 1600,
  imageQuality: 85,
);
```

**Upload with the `http` package:**

```dart
final req = http.MultipartRequest('PUT', Uri.parse('$baseUrl/v1/me/avatar'))
  ..headers['Authorization'] = 'Bearer $token'
  ..files.add(await http.MultipartFile.fromPath('file', picked.path,
      contentType: MediaType('image', 'jpeg')));
final res = await http.Response.fromStream(await req.send());
```

**Delete:**

```dart
await api.delete('/me/avatar');
```

**Show it:**

```dart
import 'package:cached_network_image/cached_network_image.dart';

Widget avatar(String? avatarUrl, String initials, String token) {
  if (avatarUrl == null) {
    return CircleAvatar(radius: 28, child: Text(initials));
  }
  return CircleAvatar(
    radius: 28,
    backgroundImage: CachedNetworkImageProvider(
      '$baseUrl$avatarUrl',
      cacheKey: avatarUrl, // a new photo = a new link = a new cache entry
      headers: {'Authorization': 'Bearer $token'},
    ),
    onBackgroundImageError: (_, __) {}, // 404 → falls back to the background colour; refresh /me
    child: null,
  );
}
```

---

## 9. Testing checklist

1. `GET /v1/me` → `avatarUrl: null`. Initials show.
2. Upload a JPEG → `200` with `avatarUrl`. The photo shows, square.
3. Upload a PNG → a new `avatarUrl`. The old link → `404`.
4. Send JSON instead of multipart → `400 AVATAR_NOT_MULTIPART`.
5. Upload a PDF renamed to `.jpg` → `400 AVATAR_NOT_IMAGE`.
6. Upload a file over 5 MB → `413 AVATAR_TOO_LARGE`.
7. Another customer looks up your username → they see your photo.
8. Delete → `{ "removed": true }`, back to initials.
