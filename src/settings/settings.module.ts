import { Global, Module } from '@nestjs/common';
import { PasswordService } from '../auth/password.service';
import { ServerSettingsService } from './server-settings.service';

/**
 * The Server settings screen's values (spec 2026-10-26), available everywhere:
 * any service reads a setting with ServerSettingsService.get(KEY).
 */
@Global()
@Module({
  providers: [ServerSettingsService, PasswordService],
  exports: [ServerSettingsService],
})
export class SettingsModule {}
