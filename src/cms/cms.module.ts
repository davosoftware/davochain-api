import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUES } from '../common/queues';
import { CmsService } from './cms.service';
import { SocialLinksService } from './social-links.service';
import { EmailTemplateService } from './email-template.service';
import { TemplatedMailService } from './templated-mail.service';
import { EmailProcessor } from './email.processor';
import { ContentController } from './content.controller';

/**
 * Global, because almost everything sends email eventually — a deposit
 * crediting, a suspension, a trade settling — and threading an import through
 * every one of those modules would say nothing except that they all send email.
 *
 * Nothing here imports the admin module, deliberately. The admin manages this
 * content and this content emails admins, so an import in both directions would
 * be a cycle; the brand fields an email needs are read from the settings row
 * directly instead.
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.EMAIL })],
  controllers: [ContentController],
  providers: [CmsService, SocialLinksService, EmailTemplateService, TemplatedMailService, EmailProcessor],
  exports: [CmsService, SocialLinksService, EmailTemplateService, TemplatedMailService],
})
export class CmsModule {}
