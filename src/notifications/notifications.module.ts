import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUES } from '../common/queues';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';
import { PushProcessor } from './push.processor';
import { BroadcastsService } from './broadcasts.service';
import { BroadcastsProcessor, BroadcastsRecovery } from './broadcasts.processor';
import { DevicesController } from './devices.controller';
import { NotificationsController } from './notifications.controller';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.NOTIFICATIONS }, { name: QUEUES.BROADCASTS })],
  controllers: [NotificationsController, DevicesController],
  providers: [NotificationsService, PushService, PushProcessor, BroadcastsService, BroadcastsProcessor, BroadcastsRecovery],
  exports: [NotificationsService, PushService, BroadcastsService],
})
export class NotificationsModule {}
