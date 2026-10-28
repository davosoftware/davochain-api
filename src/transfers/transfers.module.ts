import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module';
import { RatesModule } from '../rates/rates.module';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module';
import { TransfersService } from './transfers.service';
import { TransfersController } from './transfers.controller';

@Module({
  imports: [AssetsModule, RatesModule, WithdrawalsModule],
  controllers: [TransfersController],
  providers: [TransfersService],
})
export class TransfersModule {}
