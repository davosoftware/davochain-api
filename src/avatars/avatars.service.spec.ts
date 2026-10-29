import sharp from 'sharp';
import { MemoryFileStore } from '../storage/memory-file-store';
import { AvatarsService, avatarKey } from './avatars.service';

function build(start: { avatarId?: string | null; status?: string } = {}) {
  const user: Record<string, any> = { id: 'u1', avatarId: start.avatarId ?? null, avatarUpdatedAt: null, status: start.status ?? 'ACTIVE' };
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => (where.id === 'u1' || (where.avatarId && where.avatarId === user.avatarId) ? { ...user } : null)),
      update: jest.fn(async ({ data }: any) => Object.assign(user, data)),
    },
  };
  const files = new MemoryFileStore();
  const notifications = { notify: jest.fn(async () => undefined) };
  const svc = new AvatarsService(prisma as any, files, notifications as any);
  return { svc, user, files, notifications };
}

const jpeg = () => sharp({ create: { width: 900, height: 600, channels: 3, background: '#66B3FF' } }).jpeg().toBuffer();

describe('AvatarsService', () => {
  it('stores a 512×512 WebP under a new random id and returns its link', async () => {
    const { svc, user, files } = build();
    const r = await svc.set('u1', await jpeg());
    expect(user.avatarId).toMatch(/^[0-9a-f]{32}$/);
    expect(r.avatarUrl).toBe(`/v1/avatars/${user.avatarId}`);
    const stored = await files.get(avatarKey(user.avatarId));
    expect(stored?.contentType).toBe('image/webp');
    expect((await sharp(stored!.bytes).metadata()).width).toBe(512);
  });

  it('a new photo gets a new id, and the old file is deleted', async () => {
    const { svc, user, files } = build();
    await svc.set('u1', await jpeg());
    const first = user.avatarId;
    await svc.set('u1', await jpeg());
    expect(user.avatarId).not.toBe(first);
    expect(await files.get(avatarKey(first))).toBeNull();
    expect(await files.get(avatarKey(user.avatarId))).not.toBeNull();
  });

  it('a refused file changes nothing', async () => {
    const { svc, user } = build();
    await expect(svc.set('u1', Buffer.from('not a picture'))).rejects.toMatchObject({ response: { code: 'AVATAR_NOT_IMAGE' } });
    await expect(svc.set('u1', undefined)).rejects.toMatchObject({ response: { code: 'AVATAR_NOT_IMAGE' } });
    expect(user.avatarId).toBeNull();
  });

  it('the customer removes it: the link and the file go', async () => {
    const { svc, user, files } = build();
    await svc.set('u1', await jpeg());
    const id = user.avatarId;
    expect(await svc.remove('u1')).toEqual({ removed: true });
    expect(user.avatarId).toBeNull();
    expect(await files.get(avatarKey(id))).toBeNull();
    expect(await svc.remove('u1')).toEqual({ removed: false });
  });

  it('an admin removes it and the customer is told why', async () => {
    const { svc, user, notifications } = build();
    await svc.set('u1', await jpeg());
    await svc.removeByAdmin('u1', 'It shows a weapon');
    expect(user.avatarId).toBeNull();
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', type: 'account.avatar_removed', body: expect.stringContaining('It shows a weapon') }),
    );
    await expect(svc.removeByAdmin('u1', 'again')).rejects.toThrow('no profile photo');
  });

  it('read: serves the photo; a made-up, old or closed account link is 404', async () => {
    const { svc, user } = build();
    await svc.set('u1', await jpeg());
    expect((await svc.read(user.avatarId)).length).toBeGreaterThan(100);
    await expect(svc.read('../../kyc/secret')).rejects.toMatchObject({ response: { code: 'AVATAR_NOT_FOUND' } });
    await expect(svc.read('0'.repeat(32))).rejects.toMatchObject({ response: { code: 'AVATAR_NOT_FOUND' } });
    user.status = 'CLOSED';
    await expect(svc.read(user.avatarId)).rejects.toMatchObject({ response: { code: 'AVATAR_NOT_FOUND' } });
  });
});
