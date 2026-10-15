import { Module } from '@nestjs/common';
import { QuidaxModule } from '../quidax/quidax.module';
import { RatesService } from './rates.service';
import { FeeBandsService } from './fee-bands.service';
import { PriceReferenceService } from './price-reference.service';

@Module({
  imports: [QuidaxModule],
  providers: [RatesService, FeeBandsService, PriceReferenceService],
  exports: [RatesService, FeeBandsService, PriceReferenceService],
})
export class RatesModule {}
