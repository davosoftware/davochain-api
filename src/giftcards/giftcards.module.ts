import { Module } from '@nestjs/common';
import { GiftCardsService } from './giftcards.service';
import { GiftCardsAdminService } from './giftcards-admin.service';
import { GiftCardsController } from './giftcards.controller';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [LedgerModule],
  controllers: [GiftCardsController],
  providers: [GiftCardsService, GiftCardsAdminService],
  exports: [GiftCardsService, GiftCardsAdminService],
})
export class GiftCardsModule {}
