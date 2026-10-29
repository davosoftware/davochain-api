import { Global, Module } from '@nestjs/common';
import { AvatarsController } from './avatars.controller';
import { AvatarsService } from './avatars.service';

/** Global: the admin side and the erasure job use the service too. */
@Global()
@Module({
  controllers: [AvatarsController],
  providers: [AvatarsService],
  exports: [AvatarsService],
})
export class AvatarsModule {}
