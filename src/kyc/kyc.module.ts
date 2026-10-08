import { Module } from '@nestjs/common';
import { KycService } from './kyc.service';
import { KycController } from './kyc.controller';
import { KycHashService } from './kyc-hash';

@Module({
  controllers: [KycController],
  providers: [KycService, KycHashService],
  exports: [KycService, KycHashService],
})
export class KycModule {}
