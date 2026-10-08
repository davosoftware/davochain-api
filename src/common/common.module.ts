import { Global, Module } from '@nestjs/common';
import { SystemFlagsService } from './system-flags.service';
import { MailService } from './mail.service';
import { CredentialsService } from './credentials.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { JobLeaseService } from './job-lease.service';

@Global()
@Module({
  providers: [SystemFlagsService, IdempotencyInterceptor, MailService, CredentialsService, JobLeaseService],
  exports: [SystemFlagsService, IdempotencyInterceptor, MailService, CredentialsService, JobLeaseService],
})
export class CommonModule {}
