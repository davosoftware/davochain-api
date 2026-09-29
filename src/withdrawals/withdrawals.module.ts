import { Module } from '@nestjs/common';
import { QuidaxModule } from '../quidax/quidax.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AssetsModule } from '../assets/assets.module';
import { TradesModule } from '../trades/trades.module';
import { RatesModule } from '../rates/rates.module';
import { WithdrawalsService } from './withdrawals.service';
import { WithdrawalsController } from './withdrawals.controller';

@Module({
  imports: [QuidaxModule, LedgerModule, AssetsModule, TradesModule, RatesModule],
  controllers: [WithdrawalsController],
  providers: [WithdrawalsService],
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
