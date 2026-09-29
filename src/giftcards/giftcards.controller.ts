import { Controller, Get, Param, Post, Body, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { GiftCardsService } from './giftcards.service';
import { SubmitGiftCardDto } from './dto';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';

@ApiTags('giftcards')
@ApiBearerAuth('user')
@Controller('giftcards')
export class GiftCardsController {
  constructor(private readonly giftcards: GiftCardsService) {}

  /**
   * Everything tradeable, grouped by category.
   *
   * Public: the rates are the offer, and somebody deciding whether to install
   * the app should be able to see what a card is worth.
   */
  @Public()
  @Get('catalogue')
  catalogue() {
    return this.giftcards.catalogue();
  }

  /** A brand logo. Public, and cached hard — the URL carries a version. */
  @Public()
  @Get('brands/:id/image')
  async brandImage(@Param('id') id: string, @Res() res: Response) {
    const { image, type } = await this.giftcards.brandImage(id);
    res.setHeader('content-type', type);
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    // The website is a different origin, and a logo is meant to be shown there.
    res.setHeader('cross-origin-resource-policy', 'cross-origin');
    res.end(image);
  }

  @Post('trades')
  submit(@CurrentUser('sub') userId: string, @Body() dto: SubmitGiftCardDto) {
    return this.giftcards.submit(userId, {
      typeId: dto.typeId,
      faceValue: dto.faceValue,
      code: dto.code,
      images: dto.images ?? [],
    });
  }

  @Get('trades')
  history(@CurrentUser('sub') userId: string) {
    return this.giftcards.mine(userId);
  }

  @Get('trades/:id')
  one(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.giftcards.mine(userId, id);
  }

  /** Their own photograph, scoped to them — never anybody else's card. */
  @Get('trades/:id/images/:imageId')
  async image(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Param('imageId') imageId: string,
    @Res() res: Response,
  ) {
    const { image, type } = await this.giftcards.tradeImage(userId, id, imageId);
    res.setHeader('content-type', type);
    res.setHeader('cache-control', 'private, max-age=3600');
    res.end(image);
  }
}
