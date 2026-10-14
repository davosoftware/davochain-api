import { Module } from '@nestjs/common';
import { KycService } from './kyc.service';
import { KycController } from './kyc.controller';
import { KycHashService } from './kyc-hash';
import { BasicVerificationService } from './basic-verification.service';
import { DojahModule } from '../dojah/dojah.module';
import { ComplianceModule } from '../compliance/compliance.module';

@Module({
  imports: [DojahModule, ComplianceModule],
  controllers: [KycController],
  providers: [KycService, KycHashService, BasicVerificationService],
  exports: [KycService, KycHashService, BasicVerificationService],
})
export class KycModule {}
