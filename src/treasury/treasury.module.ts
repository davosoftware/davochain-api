import { Module } from '@nestjs/common';
import { TradesModule } from '../trades/trades.module';
import { TreasuryService } from './treasury.service';

/** Treasury: our naira at the rail and at Quidax, the daily check, and owner moves to Quidax. */
@Module({
  imports: [TradesModule],
  providers: [TreasuryService],
  exports: [TreasuryService],
})
export class TreasuryModule {}
