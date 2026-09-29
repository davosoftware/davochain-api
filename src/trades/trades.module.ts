import { forwardRef, Module } from '@nestjs/common';
import { QuidaxModule } from '../quidax/quidax.module';
import { LedgerModule } from '../ledger/ledger.module';
import { UsersModule } from '../users/users.module';
import { AssetsModule } from '../assets/assets.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SettlementService } from './settlement.service';
import { TradesService } from './trades.service';
import { TradesController } from './trades.controller';

@Module({
  imports: [
    QuidaxModule,
    LedgerModule,
    UsersModule,
    AssetsModule,
    forwardRef(() => InventoryModule),
  ],
  controllers: [TradesController],
  providers: [SettlementService, TradesService],
  exports: [SettlementService, TradesService],
})
export class TradesModule {}
