import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { RateBoardService } from './rate-board.service';

@ApiTags('trading')
@Controller('rates')
export class RatesController {
  constructor(private readonly board: RateBoardService) {}

  /**
   * Every listed coin's naira buy and sell price, for the markets screen.
   * Public, like the coin list: the app can show prices before sign-in. One
   * shared copy refreshed at most every 30 s; the price that settles is still
   * the one on the quote.
   */
  @Public()
  @RateLimit('public')
  @Get()
  rates() {
    return this.board.board();
  }
}
