import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredentialsService } from '../common/credentials.service';
import { QuidaxClient } from './quidax.client';
import { QuidaxMockClient } from './quidax.mock';
import type Redis from 'ioredis';
import { RATE_LIMIT_REDIS } from '../rate-limit/rate-limit.service';

/**
 * There is no Quidax sandbox. Everything outside production talks to the mock,
 * and the live key exists in exactly one place.
 */
@Module({
  providers: [
    {
      provide: QuidaxClient,
      inject: [ConfigService, CredentialsService, RATE_LIMIT_REDIS],
      // M9: the live client counts its Quidax budget in Redis, shared by every server.
      useFactory: (config: ConfigService, credentials: CredentialsService, redis: Redis) =>
        config.get<boolean>('QUIDAX_USE_MOCK')
          ? new QuidaxMockClient(config, credentials)
          : new QuidaxClient(config, credentials, redis),
    },
  ],
  exports: [QuidaxClient],
})
export class QuidaxModule {}
