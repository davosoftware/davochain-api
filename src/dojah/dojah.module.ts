import { Module } from '@nestjs/common';
import { DojahApi, DojahClient } from './dojah.client';
import { DojahConfig } from './dojah.config';
import { DojahMockClient } from './dojah.mock';
import { FILE_STORE, type FileStore } from '../storage/file-store';

/**
 * One Dojah client for the whole app: the mock when DOJAH_USE_MOCK=true (env
 * validation allows that only in development and test), the real client otherwise.
 */
@Module({
  providers: [
    DojahConfig,
    {
      provide: DojahApi,
      // StorageModule is @Global: the mock reads "memory://" bill links back from the same store.
      inject: [DojahConfig, FILE_STORE],
      useFactory: (cfg: DojahConfig, files: FileStore) => (cfg.useMock ? new DojahMockClient(files) : new DojahClient(cfg)),
    },
  ],
  exports: [DojahApi, DojahConfig],
})
export class DojahModule {}
