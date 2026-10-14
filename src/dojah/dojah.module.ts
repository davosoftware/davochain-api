import { Module } from '@nestjs/common';
import { DojahApi, DojahClient } from './dojah.client';
import { DojahConfig } from './dojah.config';
import { DojahMockClient } from './dojah.mock';

/**
 * One Dojah client for the whole app: the mock when DOJAH_USE_MOCK=true (env
 * validation allows that only in development and test), the real client otherwise.
 */
@Module({
  providers: [
    DojahConfig,
    {
      provide: DojahApi,
      inject: [DojahConfig],
      useFactory: (cfg: DojahConfig) => (cfg.useMock ? new DojahMockClient() : new DojahClient(cfg)),
    },
  ],
  exports: [DojahApi, DojahConfig],
})
export class DojahModule {}
