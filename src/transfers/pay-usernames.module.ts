import { Global, Module } from '@nestjs/common';
import { PayUsernamesService } from './pay-usernames.service';
import { PayUsernameBackfill } from './pay-username-backfill';

/**
 * Payment usernames, used at sign-up, by sending and by the admin (28 Oct
 * 2026). Global like the referrals service, so sign-up can reach it without
 * pulling in the whole transfers module.
 */
@Global()
@Module({
  providers: [PayUsernamesService, PayUsernameBackfill],
  exports: [PayUsernamesService],
})
export class PayUsernamesModule {}
