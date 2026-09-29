import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { JOBS, QUEUES } from '../common/queues';
import { TemplatedMailService, type TemplatedMail } from './templated-mail.service';

/**
 * Delivery runs here, off the request that caused it.
 *
 * Concurrency is low on purpose: most SMTP providers rate-limit, and a burst of
 * parallel connections is a good way to be throttled or greylisted just when a
 * batch of notifications matters most.
 */
@Processor(QUEUES.EMAIL, { concurrency: 3 })
export class EmailProcessor extends WorkerHost {
  private readonly log = new Logger(EmailProcessor.name);

  constructor(private readonly mail: TemplatedMailService) {
    super();
  }

  async process(job: Job<TemplatedMail>): Promise<unknown> {
    if (job.name !== JOBS.SEND_EMAIL) return null;

    const sent = await this.mail.deliver(job.data);
    // MailService writes every attempt to EmailLog, successful or not, so this
    // line is for a tail rather than for the record.
    if (!sent) {
      this.log.debug(`${job.data.key} to ${job.data.to} was not sent (disabled or no SMTP)`);
    }
    return { sent };
  }
}
