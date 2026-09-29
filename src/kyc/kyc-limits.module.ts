import { Global, Module } from '@nestjs/common';
import { KycLimitsService } from './kyc-limits.service';

/**
 * Global because the limits are asked about from three places — deposits,
 * withdrawals and the admin — and threading a module import through each only
 * to reach one service is ceremony.
 */
@Global()
@Module({
  providers: [KycLimitsService],
  exports: [KycLimitsService],
})
export class KycLimitsModule {}
