import { Body, Controller, Get, Post, Put, Query, UseInterceptors } from '@nestjs/common';
import { PolicyAction } from '@prisma/client';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequiresAction } from '../levels/requires-action.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { PausedDuringMaintenance } from '../common/maintenance.guard';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { PayUsernamesService } from './pay-usernames.service';
import { TransfersService } from './transfers.service';
import { SendByUsernameDto, SetPayUsernameDto } from './dto';

/** Payment usernames and sending crypto to another DavoChain customer by name (28 Oct 2026). */
@ApiTags('transfers')
@ApiBearerAuth('user')
@Controller()
export class TransfersController {
  constructor(
    private readonly usernames: PayUsernamesService,
    private readonly transfers: TransfersService,
  ) {}

  /** Choose or change your payment username (once every 30 days). */
  @Put('me/pay-username')
  setUsername(@CurrentUser('sub') userId: string, @Body() dto: SetPayUsernameDto) {
    return this.usernames.set(userId, dto.username);
  }

  /** Whether a name can be chosen, as the person types it. */
  @RateLimit('transfers.lookup')
  @Get('me/pay-username/check')
  checkUsername(@CurrentUser('sub') userId: string, @Query('username') username: string) {
    return this.usernames.check(userId, String(username ?? ''));
  }

  /** Who a username belongs to ("Ada O."), before sending. Limited, so nobody can list our customers. */
  @RateLimit('transfers.lookup')
  @Get('transfers/recipient')
  recipient(@CurrentUser('sub') userId: string, @Query('username') username: string) {
    return this.usernames.lookup(userId, String(username ?? ''));
  }

  /** Send crypto to a DavoChain customer by username: free and instant. */
  @RequiresAction(PolicyAction.CRYPTO_WITHDRAW)
  @UseInterceptors(IdempotencyInterceptor)
  @PausedDuringMaintenance()
  @Post('transfers/crypto')
  send(@CurrentUser('sub') userId: string, @Body() dto: SendByUsernameDto) {
    return this.transfers.sendByUsername(userId, dto);
  }
}
