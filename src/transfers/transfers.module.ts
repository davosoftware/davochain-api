import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module';
import { RatesModule } from '../rates/rates.module';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module';
import { PayUsernamesService } from './pay-usernames.service';
import { TransfersService } from './transfers.service';
import { TransfersController } from './transfers.controller';

@Module({
  imports: [AssetsModule, RatesModule, WithdrawalsModule],
  controllers: [TransfersController],
  providers: [PayUsernamesService, TransfersService],
  exports: [PayUsernamesService],
})
export class TransfersModule {}
