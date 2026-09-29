import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUES } from '../common/queues';
import { AddressesModule } from '../addresses/addresses.module';
import { UsersModule } from '../users/users.module';
import { DepositsModule } from '../deposits/deposits.module';
import { TradesModule } from '../trades/trades.module';
import { SignatureService } from './signature.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksProcessor } from './webhooks.processor';

@Module({
  imports: [
    AddressesModule,
    UsersModule,
    DepositsModule,
    TradesModule,
    BullModule.registerQueue({ name: QUEUES.WEBHOOKS }),
  ],
  controllers: [WebhooksController],
  providers: [SignatureService, WebhooksProcessor],
  exports: [SignatureService],
})
export class WebhooksModule {}
