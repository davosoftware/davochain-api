/**
 * Customer profile photos (29 Oct 2026), against a running server: upload,
 * see it, replace it, delete it, senders see it on lookup, admins see and
 * remove it. docs/PROFILE_PHOTO.md is the app's guide to the same calls.
 */
import sharp from 'sharp';
import { API, BASE, adminToken, call, hasAdmin, newUser, requireServer, type TestUser } from './helpers';

beforeAll(requireServer);

const describeAdmin = hasAdmin ? describe : describe.skip;

const jpeg = (w = 1200, h = 900) => sharp({ create: { width: w, height: h, channels: 3, background: '#135CF7' } }).jpeg().toBuffer();

/** What the app does: multipart/form-data with one field, "file". */
async function upload(user: TestUser, bytes: Buffer, name = 'me.jpg', type = 'image/jpeg') {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
  const res = await fetch(`${API}/me/avatar`, { method: 'PUT', headers: { authorization: `Bearer ${user.token}` }, body: form });
  return { status: res.status, body: await res.json() };
}

async function fetchPhoto(path: string, token: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
}

describeAdmin('profile photo', () => {
  let ada: TestUser;
  let bob: TestUser;
  let firstUrl: string;

  beforeAll(async () => {
    ada = await newUser('Ada', 'Photo');
    bob = await newUser('Bob', 'Looker');
  });

  it('no photo yet: GET /me says avatarUrl null', async () => {
    expect((await call('GET', '/me', { token: ada.token })).body.avatarUrl).toBeNull();
  });

  it('uploads a JPEG: stored as a 512×512 WebP, link on the profile', async () => {
    const r = await upload(ada, await jpeg());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ avatarUrl: expect.stringMatching(/^\/v1\/avatars\/[0-9a-f]{32}$/), updatedAt: expect.any(String) });
    firstUrl = r.body.avatarUrl;
    expect((await call('GET', '/me', { token: ada.token })).body.avatarUrl).toBe(firstUrl);

    const photo = await fetchPhoto(firstUrl, ada.token);
    expect(photo.status).toBe(200);
    expect(photo.headers.get('content-type')).toBe('image/webp');
    expect(photo.headers.get('cache-control')).toContain('immutable');
    expect(await sharp(photo.bytes).metadata()).toMatchObject({ format: 'webp', width: 512, height: 512 });
  });

  it('another signed-in customer can see it; nobody signed out can', async () => {
    expect((await fetchPhoto(firstUrl, bob.token)).status).toBe(200);
    expect((await fetch(`${BASE}${firstUrl}`)).status).toBe(401);
  });

  it('a sender sees the photo link when looking up the username', async () => {
    const name = (await call('GET', '/me/pay-username', { token: ada.token })).body.payUsername;
    const r = await call('GET', `/transfers/recipient?username=${name}`, { token: bob.token });
    expect(r.body).toMatchObject({ displayName: 'Ada P.', avatarUrl: firstUrl });
  });

  it('replacing it gives a new link, and the old link stops working', async () => {
    const r = await upload(ada, await sharp(await jpeg(600, 600)).png().toBuffer(), 'me.png', 'image/png');
    expect(r.status).toBe(200);
    expect(r.body.avatarUrl).not.toBe(firstUrl);
    expect((await fetchPhoto(firstUrl, ada.token)).status).toBe(404);
    expect((await fetchPhoto(r.body.avatarUrl, ada.token)).status).toBe(200);
  });

  it('refuses what is not a photo, a body that is not multipart, and a wrong field name', async () => {
    const pdf = await upload(ada, Buffer.from('%PDF-1.7 not a photo'), 'x.jpg', 'image/jpeg');
    expect(pdf).toMatchObject({ status: 400, body: { code: 'AVATAR_NOT_IMAGE' } });

    const json = await call('PUT', '/me/avatar', { token: ada.token, body: { file: 'abc' } });
    expect(json.status).toBe(400);
    expect(json.body.code).toBe('AVATAR_NOT_MULTIPART');

    const form = new FormData();
    form.append('photo', new Blob([new Uint8Array(await jpeg())], { type: 'image/jpeg' }), 'me.jpg');
    const wrong = await fetch(`${API}/me/avatar`, { method: 'PUT', headers: { authorization: `Bearer ${ada.token}` }, body: form });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).code).toBe('AVATAR_NOT_MULTIPART');
  });

  it('refuses a photo over 5 MB', async () => {
    const big = Buffer.concat([await jpeg(10, 10), Buffer.alloc(5 * 1024 * 1024)]);
    const r = await upload(ada, big);
    expect(r).toMatchObject({ status: 413, body: { code: 'AVATAR_TOO_LARGE' } });
  });

  it('the customer deletes it: profile goes back to null, the link is gone', async () => {
    const url = (await call('GET', '/me', { token: ada.token })).body.avatarUrl;
    const r = await call('DELETE', '/me/avatar', { token: ada.token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ removed: true });
    expect((await call('GET', '/me', { token: ada.token })).body.avatarUrl).toBeNull();
    expect((await fetchPhoto(url, ada.token)).status).toBe(404);
  });

  it('an admin sees it in the customer details and can remove it with a reason; the customer is told', async () => {
    const up = await upload(ada, await jpeg());
    const admin = (await adminToken())!;
    const detail = (await call('GET', `/admin/users/${ada.id}`, { token: admin })).body;
    expect(detail.avatarUrl).toBe(up.body.avatarUrl.replace('/v1/avatars/', '/v1/admin/avatars/'));
    expect((await fetchPhoto(detail.avatarUrl, admin)).status).toBe(200);

    const tooShort = await call('DELETE', `/admin/users/${ada.id}/avatar`, { token: admin, body: { reason: 'bad' } });
    expect(tooShort.status).toBe(400);
    const r = await call('DELETE', `/admin/users/${ada.id}/avatar`, { token: admin, body: { reason: 'The photo shows a weapon' } });
    expect(r.status).toBe(200);
    expect((await call('GET', '/me', { token: ada.token })).body.avatarUrl).toBeNull();

    const inbox = (await call('GET', '/notifications', { token: ada.token })).body;
    const items = (Array.isArray(inbox) ? inbox : inbox.items) as Array<{ type: string; body: string }>;
    expect(items.find((n) => n.type === 'account.avatar_removed')?.body).toContain('The photo shows a weapon');
  });
});
