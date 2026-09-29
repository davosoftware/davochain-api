import { Body, Controller, Delete, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DevicePlatform } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PushService } from './push.service';
import { CurrentUser } from '../auth/current-user.decorator';

class RegisterDeviceDto {
  /** The FCM registration token from the app. */
  @IsString() @MaxLength(500) token!: string;

  @IsEnum(DevicePlatform) platform!: DevicePlatform;

  @IsOptional() @IsString() @MaxLength(40) appVersion?: string;
}

class UnregisterDeviceDto {
  @IsString() @MaxLength(500) token!: string;
}

@ApiTags('notifications')
@ApiBearerAuth('user')
@Controller('devices')
export class DevicesController {
  constructor(private readonly push: PushService) {}

  /**
   * Called on sign-in and whenever FCM rotates the token. Safe to call
   * repeatedly — it upserts on the token.
   */
  @Post()
  register(@CurrentUser('sub') userId: string, @Body() dto: RegisterDeviceDto) {
    return this.push.registerDevice({
      userId,
      token: dto.token,
      platform: dto.platform,
      appVersion: dto.appVersion,
    });
  }

  /** Call on sign-out, or the next person to use the phone gets their alerts. */
  @Delete()
  async unregister(@CurrentUser('sub') userId: string, @Body() dto: UnregisterDeviceDto) {
    await this.push.unregisterDevice(userId, dto.token);
    return { unregistered: true };
  }

  @Get()
  list(@CurrentUser('sub') userId: string) {
    return this.push.devicesFor(userId);
  }
}
