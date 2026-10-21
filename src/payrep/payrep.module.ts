import { Module } from '@nestjs/common';
import { PayrepApi } from './payrep.api';
import { PayrepClient } from './payrep.client';
import { PayrepConfig } from './payrep.config';
import { PayrepMock } from './payrep.mock';

/** The mock when PAYREP_USE_MOCK=true (development and test only; env validation refuses it elsewhere). */
@Module({
  providers: [
    PayrepConfig,
    {
      provide: PayrepApi,
      inject: [PayrepConfig],
      useFactory: (cfg: PayrepConfig) => (cfg.useMock ? new PayrepMock(cfg) : new PayrepClient(cfg)),
    },
  ],
  exports: [PayrepConfig, PayrepApi],
})
export class PayrepModule {}
