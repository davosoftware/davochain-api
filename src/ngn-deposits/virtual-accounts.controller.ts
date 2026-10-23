import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import { VirtualAccountsService } from './virtual-accounts.service';
import { PausedDuringMaintenance } from '../common/maintenance.guard';
import { RequiresVerifiedEmail } from '../levels/requires-action.decorator';

/**
 * Nothing is needed any more (spec 2026-10-23): the account is opened from the
 * customer's verified ID. Older app builds still send a bvn or nin; both are
 * accepted so those builds keep working, and ignored (never sent or stored).
 */
export class OpenNgnAccountDto {
  @IsOptional() @IsString() @Matches(/^\d{11}$/, { message: 'A BVN is 11 digits' }) bvn?: string;
  @IsOptional() @IsString() @Matches(/^\d{11}$/, { message: 'A NIN is 11 digits' }) nin?: string;
}

@ApiTags('deposits')
@ApiBearerAuth('user')
@Controller('deposits/ngn')
export class VirtualAccountsController {
  constructor(private readonly accounts: VirtualAccountsService) {}

  /**
   * 200 the account; 202 {status: PENDING} while it is being opened (an eligible
   * customer's account is opened on this call if it hasn't been yet); 404
   * NO_VIRTUAL_ACCOUNT, with the reason, for someone who may not have one.
   */
  @Get('account')
  async account(@CurrentUser('sub') userId: string, @Res({ passthrough: true }) res: Response) {
    const result = await this.accounts.getForUser(userId);
    res.status(result.httpStatus);
    return result.body;
  }

  /** 201 opened now, 200 already had one, 202 on its way. No body needed. */
  @PausedDuringMaintenance()
  @RequiresVerifiedEmail()
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
