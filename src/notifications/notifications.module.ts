import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUES } from '../common/queues';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';
import { PushProcessor } from './push.processor';
import { DevicesController } from './devices.controller';
import { NotificationsController } from './notifications.controller';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.NOTIFICATIONS })],
  controllers: [NotificationsController, DevicesController],
  providers: [NotificationsService, PushService, PushProcessor],
  exports: [NotificationsService, PushService],
})
export class NotificationsModule {}
