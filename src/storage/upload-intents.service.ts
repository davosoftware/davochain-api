import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JobLeaseService } from '../common/job-lease.service';
import { FILE_STORE, FileStore, StorageUnavailableError } from './file-store';

/** An intent this old belongs to a request that crashed or failed; uploads time out after 30 s. */
export const INTENT_MAX_AGE_MS = 30 * 60_000;
const SWEEP_BATCH = 200;

type IntentTable = Pick<PrismaService, 'pendingUpload'>;

/**
 * Crash-safe uploads (H8).
 *
 *   1. store():  write a pending_uploads row, then put the file.
 *   2. claim():  inside the transaction that saves the record pointing at the
 *                file, remove the row. Commit = the file is owned.
 *   3. If anything fails, abandon(); if the process dies, sweep() finds the
 *      row 30 minutes later.
 *
 * Whoever removes the row owns the file's fate. abandon() and sweep() delete a
 * file only after THEY removed its row, so a file whose record committed (row
 * gone) is never deleted, even when the commit answered with an error.
 */
@Injectable()
export class UploadIntents {
  private readonly log = new Logger(UploadIntents.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORE) private readonly files: FileStore,
    @Optional() private readonly leases?: JobLeaseService,
  ) {}

  async store(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.prisma.pendingUpload.create({ data: { key } });
    try {
      await this.files.put(key, bytes, contentType);
    } catch (err) {
      // A timeout may still have stored it: remove it, best effort.
      await this.abandon([key]);
      throw err instanceof StorageUnavailableError ? err : new StorageUnavailableError(`put failed: ${(err as Error).message}`);
    }
  }

  async claim(tx: Pick<Prisma.TransactionClient, 'pendingUpload'>, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const { count } = await tx.pendingUpload.deleteMany({ where: { key: { in: keys } } });
    if (count !== keys.length) throw new StorageUnavailableError('an upload expired before it was saved');
  }

  async abandon(keys: string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.release(this.prisma, key, new Date());
      } catch (err) {
        this.log.warn(`Could not clean up upload ${key}; the sweeper will retry: ${(err as Error).message}`);
      }
    }
  }

  async sweep(now = new Date()): Promise<number> {
    const stale = await this.prisma.pendingUpload.findMany({
      where: { createdAt: { lt: new Date(now.getTime() - INTENT_MAX_AGE_MS) } },
      orderBy: { createdAt: 'asc' },
      take: SWEEP_BATCH,
    });
    let removed = 0;
    for (const row of stale) {
      try {
        if (await this.release(this.prisma, row.key, row.createdAt)) removed++;
      } catch (err) {
        this.log.warn(`Sweep could not remove ${row.key}; will retry: ${(err as Error).message}`);
      }
    }
    if (removed > 0) this.log.log(`Removed ${removed} abandoned upload(s)`);
    return removed;
  }

  @Cron('*/15 * * * *', { name: 'upload-intent-sweep' })
  async sweepCron(): Promise<void> {
    try {
      if (this.leases) await this.leases.run('upload-intent-sweep', 10 * 60_000, () => this.sweep(), { keep: true });
      else await this.sweep();
    } catch (err) {
      this.log.error(`Upload sweep failed: ${(err as Error).message}`);
    }
  }

  /**
   * Take the row; only if we took it, delete the file. A failed delete puts
   * the row back (with its age) so the next sweep tries again.
   */
  private async release(db: IntentTable, key: string, createdAt: Date): Promise<boolean> {
    const { count } = await db.pendingUpload.deleteMany({ where: { key } });
    if (count === 0) return false;
    try {
      await this.files.delete(key);
      return true;
    } catch (err) {
      await db.pendingUpload.createMany({ data: [{ key, createdAt }], skipDuplicates: true });
      throw err;
    }
  }
}
