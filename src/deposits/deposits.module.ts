import { Module } from '@nestjs/common';
import { DepositsService } from './deposits.service';
import { DepositsController } from './deposits.controller';
import { LedgerModule } from '../ledger/ledger.module';
import { RatesModule } from '../rates/rates.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [LedgerModule, UsersModule, RatesModule],
  controllers: [DepositsController],
  providers: [DepositsService],
  exports: [DepositsService],
})
export class DepositsModule {}
