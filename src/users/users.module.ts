import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUES } from '../common/queues';
import { QuidaxModule } from '../quidax/quidax.module';
import { ProvisioningService } from './provisioning.service';
import { ProvisioningProcessor } from './provisioning.processor';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

@Module({
  imports: [QuidaxModule, BullModule.registerQueue({ name: QUEUES.PROVISIONING })],
  controllers: [UsersController],
  providers: [ProvisioningService, ProvisioningProcessor, UsersService],
  exports: [ProvisioningService, UsersService],
})
export class UsersModule {}
