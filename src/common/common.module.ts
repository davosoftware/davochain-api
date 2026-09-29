import { Global, Module } from '@nestjs/common';
import { SystemFlagsService } from './system-flags.service';
import { MailService } from './mail.service';
import { CredentialsService } from './credentials.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';

@Global()
@Module({
  providers: [SystemFlagsService, IdempotencyInterceptor, MailService, CredentialsService],
  exports: [SystemFlagsService, IdempotencyInterceptor, MailService, CredentialsService],
})
export class CommonModule {}
