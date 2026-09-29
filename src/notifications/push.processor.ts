import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { JOBS, QUEUES } from '../common/queues';
import { PushService } from './push.service';

/**
 * Delivery runs on a worker, never inline.
 *
 * A notification is written to the database the moment it happens; getting it
 * onto a device is a separate concern that can be slow, can fail, and must
 * never hold up a trade settling.
 */
@Processor(QUEUES.NOTIFICATIONS, { concurrency: 5 })
export class PushProcessor extends WorkerHost {
  private readonly log = new Logger(PushProcessor.name);

  constructor(private readonly push: PushService) {
    super();
  }

  async process(job: Job<{ notificationId: string }>): Promise<unknown> {
    if (job.name !== JOBS.SEND_NOTIFICATION) return null;
    return this.push.deliver(job.data.notificationId);
  }
}
