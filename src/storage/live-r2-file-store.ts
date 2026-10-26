import type { FileStore, StoredObject } from './file-store';
import { StorageUnavailableError } from './file-store';
import type { R2Settings } from './r2-file-store';

/** Where the four R2 values come from right now (Server settings + API keys, else .env); null when one is missing. */
export type R2Source = () => Promise<R2Settings | null>;

/**
 * The R2 store, rebuilt when its account, bucket or keys are changed on the
 * dashboard (spec 2026-10-26), so a new key works without a restart. Before
 * each operation it reads the four values (cheap: both sources are cached) and
 * builds a new client only if one of them changed.
 */
export class LiveR2FileStore implements FileStore {
  readonly driver = 'r2' as const;
  private inner: FileStore | null = null;
  private builtWith = '';
  private bucketName = '';

  constructor(
    private readonly source: R2Source,
    private readonly build: (s: R2Settings) => FileStore,
  ) {}

  private async store(): Promise<FileStore> {
    const s = await this.source();
    if (!s) {
      throw new StorageUnavailableError('File storage is not set up: the R2 account, bucket or keys are missing.');
    }
    const signature = JSON.stringify([s.accountId, s.bucket, s.accessKeyId, s.secretAccessKey]);
    if (!this.inner || signature !== this.builtWith) {
      this.inner = this.build(s);
      this.builtWith = signature;
      this.bucketName = s.bucket;
    }
    return this.inner;
  }

  /** The bucket in use now (for the start-up check and the storage status). */
  async currentBucket(): Promise<string> {
    await this.store().catch(() => undefined);
    return this.bucketName;
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    return (await this.store()).put(key, bytes, contentType);
  }

  async get(key: string): Promise<StoredObject | null> {
    return (await this.store()).get(key);
  }

  async delete(key: string): Promise<void> {
    return (await this.store()).delete(key);
  }

  async ping(): Promise<boolean> {
    try {
      return await (await this.store()).ping();
    } catch {
      return false;
    }
  }

  async temporaryLink(key: string, seconds: number): Promise<string> {
    return (await this.store()).temporaryLink(key, seconds);
  }
}
