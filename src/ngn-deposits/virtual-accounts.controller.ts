import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import { VirtualAccountsService } from './virtual-accounts.service';
import { PausedDuringMaintenance } from '../common/maintenance.guard';

/** Exactly one of the two; the service enforces "exactly one". Messages never echo the value. */
export class OpenNgnAccountDto {
  @IsOptional() @IsString() @Matches(/^\d{11}$/, { message: 'A BVN is 11 digits' }) bvn?: string;
  @IsOptional() @IsString() @Matches(/^\d{11}$/, { message: 'A NIN is 11 digits' }) nin?: string;
}

@ApiTags('deposits')
@ApiBearerAuth('user')
@Controller('deposits/ngn')
export class VirtualAccountsController {
  constructor(private readonly accounts: VirtualAccountsService) {}

  /** The user's naira deposit account, or 404 NO_VIRTUAL_ACCOUNT saying whether they may open one. */
  @Get('account')
  account(@CurrentUser('sub') userId: string) {
    return this.accounts.getForUser(userId);
  }

  /** 201 created, 200 already had one, 202 Flutterwave has not confirmed yet. */
  @PausedDuringMaintenance()
  @Post('account')
  async open(
    @CurrentUser('sub') userId: string,
    @Body() dto: OpenNgnAccountDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.accounts.openForUser(userId, dto);
    res.status(result.httpStatus);
    return result.body;
  }
}
