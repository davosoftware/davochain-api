import { Module } from '@nestjs/common';
import { FlutterwaveClient } from './flutterwave.client';
import { FlutterwaveConfig } from './flutterwave.config';
import { FlutterwaveMockClient } from './flutterwave.mock';

/**
 * One Flutterwave client for the whole app: the mock when FLW_USE_MOCK=true
 * (env validation allows that only in development and test), the real client
 * otherwise.
 */
@Module({
  providers: [
    FlutterwaveConfig,
    {
      provide: FlutterwaveClient,
      inject: [FlutterwaveConfig],
      useFactory: (cfg: FlutterwaveConfig) =>
        cfg.useMock ? new FlutterwaveMockClient(cfg) : new FlutterwaveClient(cfg),
    },
  ],
  exports: [FlutterwaveConfig, FlutterwaveClient],
})
export class FlutterwaveModule {}
