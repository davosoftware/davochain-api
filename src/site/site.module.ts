import { Module } from '@nestjs/common';
import { SiteController } from './site.controller';
import { AdminModule } from '../admin/admin.module';

/** The public face of the settings the admin edits. */
@Module({
  imports: [AdminModule],
  controllers: [SiteController],
})
export class SiteModule {}
