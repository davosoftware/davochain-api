import { forwardRef, Module } from '@nestjs/common';
import { TradesModule } from '../trades/trades.module';
import { RatesModule } from '../rates/rates.module';
import { InventoryService } from './inventory.service';
import { AlertsService } from './alerts.service';

@Module({
  imports: [forwardRef(() => TradesModule), RatesModule],
  providers: [InventoryService, AlertsService],
  exports: [InventoryService, AlertsService],
})
export class InventoryModule {}
