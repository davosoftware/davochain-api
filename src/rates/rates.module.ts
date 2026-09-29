import { Module } from '@nestjs/common';
import { QuidaxModule } from '../quidax/quidax.module';
import { RatesService } from './rates.service';
import { FeeBandsService } from './fee-bands.service';

@Module({
  imports: [QuidaxModule],
  providers: [RatesService, FeeBandsService],
  exports: [RatesService, FeeBandsService],
})
export class RatesModule {}
