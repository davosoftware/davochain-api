import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredentialsService } from '../common/credentials.service';
import { QuidaxClient } from './quidax.client';
import { QuidaxMockClient } from './quidax.mock';

/**
 * There is no Quidax sandbox. Everything outside production talks to the mock,
 * and the live key exists in exactly one place.
 */
@Module({
  providers: [
    {
      provide: QuidaxClient,
      inject: [ConfigService, CredentialsService],
      useFactory: (config: ConfigService, credentials: CredentialsService) =>
        config.get<boolean>('QUIDAX_USE_MOCK')
          ? new QuidaxMockClient(config, credentials)
          : new QuidaxClient(config, credentials),
    },
  ],
  exports: [QuidaxClient],
})
export class QuidaxModule {}
