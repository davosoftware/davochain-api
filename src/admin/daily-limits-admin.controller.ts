import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PolicyAction } from '@prisma/client';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Public } from '../auth/public.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { AdminGuard } from './admin.guard';
import { RequirePermissions } from './require-permissions.decorator';
import { DailyUsageService } from '../levels/daily-usage.service';

const PAGE_SIZE = 25;

export class DailyLimitsParams {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
  @IsOptional() @IsIn(Object.values(PolicyAction)) action?: string;
  /** Only customers who used at least this percentage of some daily limit. */
  @IsOptional() @Matches(/^\d{1,3}$/) near?: string;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Matches(/^\d{1,6}$/) page?: string;
}

export class DayParam {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
}

/**
 * People → Daily limits (27 Oct 2026): how much of each verification-level
 * limit every customer used on a day, counted exactly as the limits check
 * counts it. Read-only.
 */
@Public() // opts out of the USER guard; AdminGuard takes over
@UseGuards(AdminGuard)
@RateLimit('default')
@ApiTags('admin')
@ApiBearerAuth('admin')
@Controller('admin')
export class DailyLimitsAdminController {
  constructor(private readonly usage: DailyUsageService) {}

  @Get('limits/daily')
  @RequirePermissions('users.view')
  async list(@Query() q: DailyLimitsParams) {
    const day = await this.usage.forDay({
      date: q.date,
      ...(q.near ? { nearPercent: Number(q.near) } : {}),
      ...(q.action ? { action: q.action as PolicyAction } : {}),
      ...(q.search?.trim() ? { search: q.search.trim() } : {}),
    });
    const page = Math.max(1, Number(q.page) || 1);
    return {
      date: day.date,
      ngnPerUsd: day.ngnPerUsd,
      total: day.customers.length,
      page,
      pageSize: PAGE_SIZE,
      customers: day.customers.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    };
  }

  @Get('users/:id/limits')
  @RequirePermissions('users.view')
  async forUser(@Param('id') id: string, @Query() q: DayParam) {
    const day = await this.usage.forDay({ date: q.date, userId: id });
    return { date: day.date, ngnPerUsd: day.ngnPerUsd, customer: day.customers[0] ?? null };
  }
}
