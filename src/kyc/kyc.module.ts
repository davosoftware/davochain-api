import { Module } from '@nestjs/common';
import { KycService } from './kyc.service';
import { KycController } from './kyc.controller';
import { KycHashService } from './kyc-hash';
import { BasicVerificationService, READINESS } from './basic-verification.service';
import { DojahReadinessService } from '../dojah/dojah-readiness.service';
import { DojahModule } from '../dojah/dojah.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { DojahRecoveryService } from '../dojah/dojah-recovery.service';
import { BasicReviewService } from './basic-review.service';
import { APPROVER, ComplianceReviewService } from '../compliance/compliance-review.service';

@Module({
  imports: [DojahModule, ComplianceModule],
  controllers: [KycController],
  providers: [
    KycService,
    KycHashService,
    BasicVerificationService,
    DojahRecoveryService,
    BasicReviewService,
    ComplianceReviewService,
    // Compliance releases a person through Basic approval; this token keeps the module graph acyclic.
    { provide: APPROVER, useExisting: BasicVerificationService },
    DojahReadinessService,
    { provide: READINESS, useExisting: DojahReadinessService },
  ],
  exports: [KycService, KycHashService, BasicVerificationService, DojahRecoveryService, BasicReviewService, ComplianceReviewService, DojahReadinessService],
})
export class KycModule {}
