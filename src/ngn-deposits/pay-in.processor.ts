import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { JOBS, QUEUES } from '../common/queues';
import { redactIds } from '../flutterwave/flutterwave.errors';
import { PayInService, type PayInJob, type PayInResult } from './pay-in.service';

/** Works the flutterwave queue. A throw means "not known yet": BullMQ retries with backoff. */
@Injectable()
@Processor(QUEUES.FLUTTERWAVE, { concurrency: 5 })
export class PayInProcessor extends WorkerHost {
  private readonly log = new Logger(PayInProcessor.name);

  constructor(private readonly payIn: PayInService) {
    super();
  }

  async process(job: Job<PayInJob>): Promise<PayInResult | null> {
    if (job.name !== JOBS.PROCESS_FLW_PAYIN) return null;
    const { flwTransactionId, reason } = job.data;
    try {
      return await this.payIn.processPayment(flwTransactionId, reason === 'WEBHOOK' ? 'WEBHOOK' : 'SWEEP');
    } catch (err) {
      this.log.warn(
        `Flutterwave payment ${flwTransactionId}, attempt ${job.attemptsMade + 1}: ${redactIds((err as Error).message)}`,
      );
      throw err;
    }
  }
}
