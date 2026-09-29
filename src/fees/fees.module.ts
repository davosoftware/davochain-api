import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUES } from '../common/queues';
import { QuidaxModule } from '../quidax/quidax.module';
import { TradesModule } from '../trades/trades.module';
import { RatesModule } from '../rates/rates.module';
import { FeeClaimsService } from './fee-claims.service';
import { FeeClaimsProcessor } from './fee-claims.processor';

@Module({
  imports: [
    QuidaxModule,
    TradesModule,
    RatesModule,
    BullModule.registerQueue({ name: QUEUES.FEE_CLAIMS }),
  ],
  providers: [FeeClaimsService, FeeClaimsProcessor],
  exports: [FeeClaimsService],
})
export class FeesModule {}
