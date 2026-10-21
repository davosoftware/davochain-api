import { Module } from '@nestjs/common';
import { KycService } from './kyc.service';
import { KycController } from './kyc.controller';
import { KycDocumentsService } from './kyc-documents.service';
import { KycHashService } from './kyc-hash';
import { BasicVerificationService, READINESS } from './basic-verification.service';
import { DojahReadinessService } from '../dojah/dojah-readiness.service';
import { DojahModule } from '../dojah/dojah.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { DojahRecoveryService } from '../dojah/dojah-recovery.service';
import { BasicReviewService } from './basic-review.service';
import { APPROVER, ComplianceReviewService } from '../compliance/compliance-review.service';
import { AdvancedVerificationService } from './advanced/advanced-verification.service';
import { AdvancedApprover } from './advanced/advanced-approver';
import { AdvancedRunner } from './advanced/advanced-runner.service';
import { AdvancedProcessor } from './advanced/advanced.processor';
import { AdvancedReviewService } from './advanced/advanced-review.service';

@Module({
  imports: [DojahModule, ComplianceModule],
  controllers: [KycController],
  providers: [
    KycService,
    KycDocumentsService,
    KycHashService,
    BasicVerificationService,
    DojahRecoveryService,
    BasicReviewService,
    ComplianceReviewService,
    AdvancedVerificationService,
    AdvancedApprover,
    AdvancedRunner,
    AdvancedProcessor,
    AdvancedReviewService,
    // Compliance releases a person through Basic approval; this token keeps the module graph acyclic.
    { provide: APPROVER, useExisting: BasicVerificationService },
    DojahReadinessService,
    { provide: READINESS, useExisting: DojahReadinessService },
  ],
  exports: [KycService, KycDocumentsService, KycHashService, BasicVerificationService, DojahRecoveryService, BasicReviewService, ComplianceReviewService, DojahReadinessService, AdvancedVerificationService, AdvancedApprover, AdvancedRunner, AdvancedReviewService],
})
export class KycModule {}
