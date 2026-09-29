import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUES } from '../common/queues';
import { QuidaxModule } from '../quidax/quidax.module';
import { AssetsModule } from '../assets/assets.module';
import { UsersModule } from '../users/users.module';
import { AddressesService } from './addresses.service';
import { AddressesController } from './addresses.controller';
import { AddressesProcessor } from './addresses.processor';

@Module({
  imports: [
    QuidaxModule,
    AssetsModule,
    UsersModule,
    BullModule.registerQueue({ name: QUEUES.ADDRESSES }),
  ],
  controllers: [AddressesController],
  providers: [AddressesService, AddressesProcessor],
  exports: [AddressesService],
})
export class AddressesModule {}
