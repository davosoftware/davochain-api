import { Global, Module } from '@nestjs/common';
import { ReferralsService } from './referrals.service';
import { ReferralsController } from './referrals.controller';
import { LedgerModule } from '../ledger/ledger.module';

/**
 * Global, because several unrelated places have to tell it something happened:
 * registration attaches a referrer, a KYC approval may release a reward, and a
 * completed trade may release another. Threading the module through each of
 * their import lists would say less about the design than this does.
 */
@Global()
@Module({
  imports: [LedgerModule],
  controllers: [ReferralsController],
  providers: [ReferralsService],
  exports: [ReferralsService],
})
export class ReferralsModule {}
