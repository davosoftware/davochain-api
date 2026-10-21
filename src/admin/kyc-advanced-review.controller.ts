import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { AdminGuard } from './admin.guard';
import { CurrentAdmin } from './current-admin.decorator';
import { RequirePermissions } from './require-permissions.decorator';
import { AdvancedReviewService, REVIEW_REASONS, type ReviewRejectReason } from '../kyc/advanced/advanced-review.service';

export class AdvancedDecisionDto {
  @IsBoolean() approve!: boolean;
  @IsIn(REVIEW_REASONS as ReviewRejectReason[]) reason!: ReviewRejectReason;
  /** Shown to the customer only when the reason is OTHER. */
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

/** Advanced checks a rule could not decide (spec 2026-10-21 §8). */
@Public() // opts out of the USER guard; AdminGuard takes over
@UseGuards(AdminGuard)
@RateLimit('default')
@ApiTags('admin')
@ApiBearerAuth('admin')
@Controller('admin/kyc/advanced')
export class KycAdvancedReviewController {
  constructor(private readonly review: AdvancedReviewService) {}

  @Get()
  @RequirePermissions('kyc.view')
  list() {
    return this.review.list();
  }

  @Post(':id/decision')
  @HttpCode(200)
  @RequirePermissions('kyc.review')
  decide(@CurrentAdmin('sub') adminId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdvancedDecisionDto, @Req() req: Request) {
    // Audited inside the same transaction as the decision.
    return this.review.decide({ adminId, ip: req.ip }, id, dto);
  }
}
