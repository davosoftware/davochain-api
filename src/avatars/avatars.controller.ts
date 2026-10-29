import { Controller, Delete, Get, Param, Put, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { PausedDuringMaintenance } from '../common/maintenance.guard';
import { AvatarsService } from './avatars.service';
import { AvatarUploadInterceptor } from './avatar-upload.interceptor';
import { sendAvatar } from './send-avatar';

/** Customer profile photos (29 Oct 2026). docs/PROFILE_PHOTO.md is the app's guide. */
@ApiTags('profile-photo')
@ApiBearerAuth('user')
@Controller()
export class AvatarsController {
  constructor(private readonly avatars: AvatarsService) {}

  /** Upload or replace: multipart/form-data, one field "file" (JPEG, PNG or WebP, up to 5 MB). */
  @PausedDuringMaintenance()
  @RateLimit('avatar.upload')
  @Put('me/avatar')
  @UseInterceptors(AvatarUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  upload(@CurrentUser('sub') userId: string, @UploadedFile() file: { buffer: Buffer } | undefined) {
    return this.avatars.set(userId, file?.buffer);
  }

  @Delete('me/avatar')
  remove(@CurrentUser('sub') userId: string) {
    return this.avatars.remove(userId);
  }

  /** The photo itself, for any signed-in customer who has its link. */
  @Get('avatars/:id')
  async show(@Param('id') id: string, @Res() res: Response) {
    sendAvatar(res, await this.avatars.read(id));
  }
}
