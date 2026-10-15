import { Controller, Get } from '@nestjs/common';
import { UsersService } from './users.service';
import { LevelPolicyService } from '../levels/level-policy.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('user')
@ApiBearerAuth('user')
@Controller()
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly policy: LevelPolicyService,
  ) {}

  @Get('me')
  profile(@CurrentUser('sub') userId: string) {
    return this.users.profile(userId);
  }

  /** What this person may do at their verification level, and what is left today. */
  @Get('me/level')
  level(@CurrentUser('sub') userId: string) {
    return this.policy.snapshotFor(userId);
  }

  @Get('wallets')
  balances(@CurrentUser('sub') userId: string) {
    return this.users.balances(userId);
  }
}
