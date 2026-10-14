import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { AdminGuard } from './admin.guard';
import { CurrentAdmin } from './current-admin.decorator';
import { RequirePermissions } from './require-permissions.decorator';
import { BasicReviewService } from '../kyc/basic-review.service';

export class BasicDecisionDto {
  @IsBoolean() approve!: boolean;
  @IsString() @MinLength(10) @MaxLength(500) reason!: string;
}

/** A person decides a Basic verification whose identity did not match (spec §11). */
@Public() // opts out of the USER guard; AdminGuard takes over
@UseGuards(AdminGuard)
@RateLimit('default')
@ApiTags('admin')
@ApiBearerAuth('admin')
@Controller('admin/kyc')
export class KycBasicReviewController {
  constructor(private readonly review: BasicReviewService) {}

  @Post(':userId/basic-decision')
  @RequirePermissions('kyc.review')
  decide(@CurrentAdmin('sub') adminId: string, @Param('userId') userId: string, @Body() dto: BasicDecisionDto, @Req() req: Request) {
    // Audited inside the same transaction as the decision.
    return this.review.decide({ adminId, ip: req.ip }, userId, dto);
  }
}
