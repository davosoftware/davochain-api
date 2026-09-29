import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUES } from '../common/queues';
import { QuidaxModule } from '../quidax/quidax.module';
import { AssetsService } from './assets.service';
import { AssetsController } from './assets.controller';
import { SyncProcessor } from './sync.processor';

@Module({
  imports: [QuidaxModule, BullModule.registerQueue({ name: QUEUES.SYNC })],
  controllers: [AssetsController],
  providers: [AssetsService, SyncProcessor],
  exports: [AssetsService],
})
export class AssetsModule {}
