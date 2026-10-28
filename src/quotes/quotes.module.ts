import { Module } from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { QuotesController } from './quotes.controller';
import { RatesController } from './rates.controller';
import { RateBoardService } from './rate-board.service';
import { RatesModule } from '../rates/rates.module';
import { AssetsModule } from '../assets/assets.module';
import { LedgerModule } from '../ledger/ledger.module';
import { TradesModule } from '../trades/trades.module';

@Module({
  imports: [RatesModule, AssetsModule, LedgerModule, TradesModule],
  controllers: [QuotesController, RatesController],
  providers: [QuotesService, RateBoardService],
  exports: [QuotesService],
})
export class QuotesModule {}
