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
import { WebhookRedriveService } from './webhook-redrive.service';
import { QuidaxEventConfirmer } from './quidax-event-confirmer';
import { QuidaxModule } from '../quidax/quidax.module';

@Module({
  imports: [
    AddressesModule,
    UsersModule,
    DepositsModule,
    TradesModule,
    // A1: every money message is checked with Quidax before it is acted on.
    QuidaxModule,
    BullModule.registerQueue({ name: QUEUES.WEBHOOKS }),
  ],
  controllers: [WebhooksController],
  providers: [SignatureService, WebhooksProcessor, WebhookRedriveService, QuidaxEventConfirmer],
  exports: [SignatureService],
})
export class WebhooksModule {}
