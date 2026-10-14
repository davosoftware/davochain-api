import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { AdminGuard } from './admin.guard';
import { CurrentAdmin } from './current-admin.decorator';
import { RequirePermissions } from './require-permissions.decorator';
import type { AdminJwtPayload } from './admin.service';
import { ComplianceReviewService, type Actor, type Decision } from '../compliance/compliance-review.service';

const DECISIONS: Decision[] = ['CLEARED', 'PEP_APPROVED_EDD', 'RESTRICTED', 'SANCTIONS_CONFIRMED', 'SANCTIONS_FALSE_POSITIVE'];

export class DecideCaseDto {
  @IsIn(DECISIONS) decision!: Decision;
  @IsString() @MinLength(10) @MaxLength(1000) reason!: string;
  @IsOptional() @IsBoolean() reportedToAuthority?: boolean;
  @IsOptional() @IsString() @MaxLength(100) reportReference?: string;
  @IsOptional() @IsDateString() reportedAt?: string;
}

export class ConfirmCaseDto {
  @IsBoolean() confirm!: boolean;
  @IsString() @MinLength(10) @MaxLength(1000) reason!: string;
}

export class CaseReasonDto {
  @IsString() @MinLength(5) @MaxLength(500) reason!: string;
}

/** AdminGuard puts the database's role and permissions on req.admin. */
type GuardedAdmin = AdminJwtPayload & { permissions?: string[] };
const actorOf = (a: GuardedAdmin, req: Request): Actor => ({
  adminId: a.sub,
  role: a.role as Actor['role'],
  permissions: a.permissions ?? [],
  ip: req.ip,
});

/** AML review cases (spec §9, §11, §14.1). Opening and deciding are audited. */
@Public() // opts out of the USER guard; AdminGuard takes over
@UseGuards(AdminGuard)
@RateLimit('default')
@ApiTags('admin')
@ApiBearerAuth('admin')
@Controller('admin/compliance')
export class ComplianceController {
  constructor(private readonly review: ComplianceReviewService) {}

  @Get('cases')
  @RequirePermissions('compliance.view')
  list(@Query('filter') filter?: string) {
    return this.review.list(filter === 'decided' ? 'decided' : 'open');
  }

  @Get('cases/:id')
  @RequirePermissions('compliance.view')
  detail(@CurrentAdmin() a: GuardedAdmin, @Param('id') id: string, @Req() req: Request) {
    return this.review.detail(actorOf(a, req), id);
  }

  @Post('cases/:id/decide')
  @RequirePermissions('compliance.review')
  decide(@CurrentAdmin() a: GuardedAdmin, @Param('id') id: string, @Body() dto: DecideCaseDto, @Req() req: Request) {
    return this.review.decide(actorOf(a, req), id, dto);
  }

  @Post('cases/:id/confirm')
  @RequirePermissions('compliance.review')
  confirm(@CurrentAdmin() a: GuardedAdmin, @Param('id') id: string, @Body() dto: ConfirmCaseDto, @Req() req: Request) {
    return this.review.confirm(actorOf(a, req), id, dto);
  }

  @Post('cases/:id/withdraw')
  @RequirePermissions('compliance.review')
  withdraw(@CurrentAdmin() a: GuardedAdmin, @Param('id') id: string, @Body() dto: CaseReasonDto, @Req() req: Request) {
    return this.review.withdraw(actorOf(a, req), id, dto.reason);
  }

  @Post('cases/:id/rescreen')
  @RequirePermissions('compliance.review')
  rescreen(@CurrentAdmin() a: GuardedAdmin, @Param('id') id: string, @Body() dto: CaseReasonDto, @Req() req: Request) {
    return this.review.rescreen(actorOf(a, req), id, dto.reason);
  }
}
