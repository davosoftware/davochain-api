import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ReferralsService } from './referrals.service';
import { SetUsernameDto } from './dto';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';

@ApiTags('referrals')
@ApiBearerAuth('user')
@Controller('referrals')
export class ReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  /**
   * Everything the referral screen renders: the code, the link, the offer, the
   * people invited and what each is waiting for.
   *
   * Opening it also settles anything now due — see ReferralsService.dashboard.
   */
  @Get('me')
  me(@CurrentUser('sub') userId: string) {
    return this.referrals.dashboard(userId);
  }

  /**
   * Claim a username, which becomes the referral code.
   *
   * Once only. The generated code is retired the moment this succeeds, and a
   * code that has been shared cannot be made to point somewhere else later.
   */
  @Put('username')
  setUsername(@CurrentUser('sub') userId: string, @Body() dto: SetUsernameDto) {
    return this.referrals.setUsername(userId, dto.username);
  }

  /**
   * Whose code is this? Unauthenticated, for the signup screen.
   *
   * Returns only a first name — enough for "You were invited by Ada", and
   * nothing that would turn guessing codes into a way to harvest identities.
   */
  @Public()
  @Get('code/:code')
  async check(@Param('code') code: string) {
    const owner = await this.referrals.resolve(code);
    const settings = await this.referrals.settings();
    return {
      valid: owner !== null && settings.isEnabled,
      referrerFirstName: owner?.firstName ?? null,
      /** What the person signing up would get. */
      bonusNgn: settings.isEnabled ? settings.refereeRewardNgn.toFixed(2) : '0.00',
    };
  }
}
