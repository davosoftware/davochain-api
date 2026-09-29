import { Controller, Get } from '@nestjs/common';
import { UsersService } from './users.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('user')
@ApiBearerAuth('user')
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  profile(@CurrentUser('sub') userId: string) {
    return this.users.profile(userId);
  }

  @Get('wallets')
  balances(@CurrentUser('sub') userId: string) {
    return this.users.balances(userId);
  }
}
