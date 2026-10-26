import { Global, Inject, Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FILE_STORE, FileStore } from './file-store';
import { MemoryFileStore } from './memory-file-store';
import { R2FileStore, makeR2Client, r2Presigner, type R2Settings } from './r2-file-store';
import { LiveR2FileStore } from './live-r2-file-store';
import { CredentialsService } from '../common/credentials.service';
import { ServerSettingsService } from '../settings/server-settings.service';
import { UploadIntents } from './upload-intents.service';

/** One R2 store for fixed settings. */
export function r2StoreFor(s: R2Settings): R2FileStore {
  const client = makeR2Client(s);
  return new R2FileStore(client, s.bucket, r2Presigner(client, s.bucket));
}

/**
 * Builds the store STORAGE_DRIVER names (which stays in .env). For R2, the
 * account ID and bucket come from System → Server settings and the two keys
 * from System → API keys, each falling back to .env, and the store follows a
 * change without a restart (spec 2026-10-26).
 */
export function fileStoreFrom(config: ConfigService, credentials?: CredentialsService, settings?: ServerSettingsService): FileStore {
  if (config.get<string>('STORAGE_DRIVER') !== 'r2') return new MemoryFileStore();
  const setting = (k: 'R2_ACCOUNT_ID' | 'R2_BUCKET') => (settings ? settings.get<string>(k) : config.get<string>(k));
  const secret = async (name: 'r2.accessKeyId' | 'r2.secretAccessKey', env: string) =>
    (credentials ? await credentials.get(name).catch(() => undefined) : undefined) ?? config.get<string>(env);
  return new LiveR2FileStore(async () => {
    const accountId = setting('R2_ACCOUNT_ID');
    const bucket = setting('R2_BUCKET');
    const accessKeyId = await secret('r2.accessKeyId', 'R2_ACCESS_KEY_ID');
    const secretAccessKey = await secret('r2.secretAccessKey', 'R2_SECRET_ACCESS_KEY');
    return accountId && bucket && accessKeyId && secretAccessKey ? { accountId, bucket, accessKeyId, secretAccessKey } : null;
  }, r2StoreFor);
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
    const bucket = this.store instanceof LiveR2FileStore ? await this.store.currentBucket() : (this.store as R2FileStore).bucket;
    if (await this.store.ping()) this.log.log(`File storage: Cloudflare R2, bucket "${bucket}" reachable.`);
    else this.log.error(`File storage: Cloudflare R2 bucket "${bucket}" is NOT reachable. Uploads will answer 503 until it is.`);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: FILE_STORE,
      inject: [ConfigService, CredentialsService, { token: ServerSettingsService, optional: true }],
      useFactory: fileStoreFrom,
    },
    StorageStartupCheck,
    UploadIntents,
  ],
  exports: [FILE_STORE, UploadIntents],
})
export class StorageModule {}
