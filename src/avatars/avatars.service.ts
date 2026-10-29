import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { FILE_STORE, FileStore, storageHttpError } from '../storage/file-store';
import { NotificationsService } from '../notifications/notifications.service';
import { shrinkAvatar } from './avatar-image';

/** Where a photo lives in storage. Only the server picks the id. */
export const avatarKey = (avatarId: string) => `avatars/${avatarId}.webp`;

/** The link the app shows the photo from (signed-in customers), or null. */
export const avatarUrl = (avatarId: string | null | undefined) => (avatarId ? `/v1/avatars/${avatarId}` : null);

/** The same photo for the dashboard (admin sign-in). */
export const adminAvatarUrl = (avatarId: string | null | undefined) => (avatarId ? `/v1/admin/avatars/${avatarId}` : null);

const AVATAR_ID = /^[0-9a-f]{32}$/;

/**
 * Customer profile photos (29 Oct 2026). Stored in R2 as a 512×512 WebP under
 * a random id; a change makes a new id, so an old link stops working and an
 * app can cache a photo for good.
 */
@Injectable()
export class AvatarsService {
  private readonly log = new Logger(AvatarsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORE) private readonly files: FileStore,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /** Upload or replace. The new photo is stored before the old one goes. */
  async set(userId: string, bytes: Buffer | undefined): Promise<{ avatarUrl: string; updatedAt: Date }> {
    const before = await this.current(userId);
    const image = await shrinkAvatar(bytes ?? Buffer.alloc(0));
    const id = randomBytes(16).toString('hex');
    await this.files.put(avatarKey(id), image, 'image/webp').catch((e) => {
      throw storageHttpError(e);
    });
    const updatedAt = new Date();
    await this.prisma.user.update({ where: { id: userId }, data: { avatarId: id, avatarUpdatedAt: updatedAt } });
    if (before) await this.deleteFile(before);
    return { avatarUrl: avatarUrl(id)!, updatedAt };
  }

  /** The customer removes their own photo. Removing none is fine. */
  async remove(userId: string): Promise<{ removed: boolean }> {
    const before = await this.current(userId);
    if (!before) return { removed: false };
    await this.prisma.user.update({ where: { id: userId }, data: { avatarId: null, avatarUpdatedAt: null } });
    await this.deleteFile(before);
    return { removed: true };
  }

  /** People → Users: an admin takes down an offensive photo. The customer is told why. */
  async removeByAdmin(userId: string, reason: string): Promise<{ before: string }> {
    const before = await this.current(userId);
    if (!before) throw new NotFoundException('This customer has no profile photo.');
    await this.remove(userId);
    await this.notifications?.notify({
      userId,
      type: 'account.avatar_removed',
      title: 'Your profile photo was removed',
      body: `We removed your profile photo: ${reason}. You can upload a different one.`,
    });
    return { before };
  }

  /** The photo behind a link, or 404. Closed accounts' photos are not shown. */
  async read(avatarId: string): Promise<Buffer> {
    if (!AVATAR_ID.test(avatarId)) throw this.missing();
    const owner = await this.prisma.user.findUnique({ where: { avatarId }, select: { status: true } });
    if (!owner || owner.status === 'CLOSED') throw this.missing();
    const file = await this.files.get(avatarKey(avatarId)).catch((e) => {
      throw storageHttpError(e);
    });
    if (!file) throw this.missing();
    return file.bytes;
  }

  private async current(userId: string): Promise<string | null> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { avatarId: true } });
    if (!u) throw new NotFoundException('User not found');
    return u.avatarId;
  }

  /** After the change is saved. A file left behind is logged, never a reason to fail. */
  private async deleteFile(avatarId: string): Promise<void> {
    await this.files.delete(avatarKey(avatarId)).catch((e: Error) => this.log.warn(`Could not delete old photo ${avatarId}: ${e.message}`));
  }

  private missing() {
    return new NotFoundException({ code: 'AVATAR_NOT_FOUND', message: 'No such photo.' });
  }
}
