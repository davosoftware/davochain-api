import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MailService } from '../common/mail.service';
import { EmailTemplateService } from './email-template.service';
import { DEFAULT_JOB_OPTS, JOBS, QUEUES, jobId } from '../common/queues';

export interface TemplatedMail {
  key: string;
  to: string;
  variables?: Record<string, string | null | undefined>;
  /** Makes the job id unique per event, so a retried webhook cannot re-send. */
  dedupeOn?: string;
}

/**
 * Sending an email is never allowed to be part of the thing that caused it.
 *
 * A deposit credits, a trade settles, an account is suspended — none of those
 * may fail, or even be slowed down, because SMTP was unreachable. So the caller
 * hands the message to a queue and returns; delivery, retries and the record of
 * what happened are the worker's problem.
 */
@Injectable()
export class TemplatedMailService {
  private readonly log = new Logger(TemplatedMailService.name);

  constructor(
    private readonly templates: EmailTemplateService,
    private readonly mail: MailService,
    @InjectQueue(QUEUES.EMAIL) private readonly queue: Queue,
  ) {}

  /**
   * Queue one. Never throws — a caller in a money path must not have to guard
   * against the mailer, and losing an email is not worth failing a deposit for.
   */
  async send(message: TemplatedMail): Promise<void> {
    await this.queue
      .add(JOBS.SEND_EMAIL, message, {
        ...DEFAULT_JOB_OPTS,
        // Quidax re-sends webhooks, and a user who gets "deposit successful"
        // three times stops trusting the product. The id makes the second and
        // third attempts no-ops rather than duplicates.
        ...(message.dedupeOn ? { jobId: jobId('mail', message.key, message.dedupeOn) } : {}),
      })
      .catch((err: Error) =>
        this.log.error(`Could not queue ${message.key} to ${message.to}: ${err.message}`),
      );
  }

  /**
   * Render and deliver, right now. The worker's inner call.
   *
   * Returns false when nothing was sent — either the template is switched off
   * or SMTP is not configured. Neither is an error worth retrying, so the
   * processor treats both as done.
   */
  async deliver(message: TemplatedMail): Promise<boolean> {
    const rendered = await this.templates.render(message.key, message.variables ?? {});
    if (!rendered) {
      // Switched off in the dashboard. That is a decision, not a failure.
      return false;
    }

    return this.mail.send({
      to: message.to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      templateKey: message.key,
    });
  }
}
