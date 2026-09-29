import { Controller, Get, Query } from '@nestjs/common';
import { DepositsService } from './deposits.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('deposits')
@ApiBearerAuth('user')
@Controller('deposits')
export class DepositsController {
  constructor(private readonly deposits: DepositsService) {}

  @Get()
  history(@CurrentUser('sub') userId: string, @Query('limit') limit?: string) {
    return this.deposits.history(userId, limit ? Number(limit) : 50);
  }
}
