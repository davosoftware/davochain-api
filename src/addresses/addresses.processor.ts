import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { JOBS, QUEUES, jobId } from '../common/queues';
import { AddressesService } from './addresses.service';

/**
 * Backstop for a lost wallet.address.generated webhook. Quidax retries five
 * times and then stops forever, so a poller is not optional.
 */
@Processor(QUEUES.ADDRESSES, { concurrency: 3 })
export class AddressesProcessor extends WorkerHost {
  private readonly log = new Logger(AddressesProcessor.name);
  private static readonly MAX_POLLS = 20;

  constructor(
    private readonly addresses: AddressesService,
    @InjectQueue(QUEUES.ADDRESSES) private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job<{ addressId: string; attempt?: number }>): Promise<unknown> {
    if (job.name !== JOBS.POLL_ADDRESS) return null;

    const attempt = job.data.attempt ?? 1;
    const resolved = await this.addresses.resolve(job.data.addressId);
    if (resolved?.address) return { address: resolved.address };

    if (attempt >= AddressesProcessor.MAX_POLLS) {
      this.log.error(
        `Address ${job.data.addressId} never generated after ${attempt} polls — needs a human`,
      );
      return { gaveUp: true };
    }

    // Back off: quick at first, then slow. Most resolve within seconds.
    const delay = Math.min(300_000, 15_000 * attempt);
    await this.queue.add(
      JOBS.POLL_ADDRESS,
      { addressId: job.data.addressId, attempt: attempt + 1 },
      { delay, jobId: jobId('poll', job.data.addressId, Date.now()) },
    );
    return { retryIn: delay };
  }
}
