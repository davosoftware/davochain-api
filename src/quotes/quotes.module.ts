import { Module } from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { QuotesController } from './quotes.controller';
import { RatesModule } from '../rates/rates.module';
import { AssetsModule } from '../assets/assets.module';
import { LedgerModule } from '../ledger/ledger.module';
import { TradesModule } from '../trades/trades.module';

@Module({
  imports: [RatesModule, AssetsModule, LedgerModule, TradesModule],
  controllers: [QuotesController],
  providers: [QuotesService],
  exports: [QuotesService],
})
export class QuotesModule {}
