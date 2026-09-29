import { Module } from '@nestjs/common';
import { QuidaxModule } from '../quidax/quidax.module';
import { LedgerModule } from '../ledger/ledger.module';
import { TradesModule } from '../trades/trades.module';
import { DepositsModule } from '../deposits/deposits.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [QuidaxModule, LedgerModule, TradesModule, DepositsModule, InventoryModule],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
