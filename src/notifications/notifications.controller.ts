import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { NotificationsService } from './notifications.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

class MarkReadDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ids?: string[];
}

@ApiTags('notifications')
@ApiBearerAuth('user')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  feed(@CurrentUser('sub') userId: string, @Query('limit') limit?: string) {
    return this.notifications.feed(userId, limit ? Number(limit) : 50);
  }

  @Post('read')
  async markRead(@CurrentUser('sub') userId: string, @Body() dto: MarkReadDto) {
    return { updated: await this.notifications.markRead(userId, dto.ids) };
  }
}
