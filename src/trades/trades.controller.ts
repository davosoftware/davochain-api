import { Controller, Get, Param, Query } from '@nestjs/common';
import { TradesService } from './trades.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('trading')
@ApiBearerAuth('user')
@Controller('trades')
export class TradesController {
  constructor(private readonly trades: TradesService) {}

  @Get()
  history(@CurrentUser('sub') userId: string, @Query('limit') limit?: string) {
    return this.trades.history(userId, limit ? Number(limit) : 50);
  }

  /** Poll a trade — for a client that missed the push. */
  @Get(':id')
  get(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.trades.get(userId, id);
  }
}
