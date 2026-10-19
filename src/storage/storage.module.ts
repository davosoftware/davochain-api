import { Global, Inject, Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FILE_STORE, FileStore } from './file-store';
import { MemoryFileStore } from './memory-file-store';
import { R2FileStore, makeR2Client } from './r2-file-store';

/** Builds the store STORAGE_DRIVER names. env.validation.ts has already checked the settings. */
export function fileStoreFrom(config: ConfigService): FileStore {
  if (config.get<string>('STORAGE_DRIVER') !== 'r2') return new MemoryFileStore();
  const bucket = config.getOrThrow<string>('R2_BUCKET');
  const client = makeR2Client({
    accountId: config.getOrThrow<string>('R2_ACCOUNT_ID'),
    accessKeyId: config.getOrThrow<string>('R2_ACCESS_KEY_ID'),
    secretAccessKey: config.getOrThrow<string>('R2_SECRET_ACCESS_KEY'),
    bucket,
  });
  return new R2FileStore(client, bucket);
}

/** Says at startup which store is in use and whether it answers. Never stops the server. */
@Injectable()
export class StorageStartupCheck implements OnApplicationBootstrap {
  private readonly log = new Logger('Storage');

  constructor(@Inject(FILE_STORE) private readonly store: FileStore) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.store.driver === 'memory') {
      this.log.warn('File storage: in memory (development/test). Uploaded files vanish when the server stops.');
      return;
    }
    const bucket = (this.store as R2FileStore).bucket;
    if (await this.store.ping()) this.log.log(`File storage: Cloudflare R2, bucket "${bucket}" reachable.`);
    else this.log.error(`File storage: Cloudflare R2 bucket "${bucket}" is NOT reachable. Uploads will answer 503 until it is.`);
  }
}

@Global()
@Module({
  providers: [
    { provide: FILE_STORE, inject: [ConfigService], useFactory: fileStoreFrom },
    StorageStartupCheck,
  ],
  exports: [FILE_STORE],
})
export class StorageModule {}
