import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { JOBS, QUEUES } from '../common/queues';
import { redactIds } from '../common/redact';
import { PayInService, type PayInJob, type PayInResult } from './pay-in.service';

/** Works the naira-deposits queue. A throw means "not known yet": BullMQ retries with backoff. */
@Injectable()
@Processor(QUEUES.NAIRA_DEPOSITS, { concurrency: 5 })
export class PayInProcessor extends WorkerHost {
  private readonly log = new Logger(PayInProcessor.name);

  constructor(private readonly payIn: PayInService) {
    super();
  }

  async process(job: Job<PayInJob>): Promise<PayInResult | null> {
    if (job.name !== JOBS.PROCESS_NAIRA_PAYIN) return null;
    const { providerTransactionId } = job.data;
    try {
      return await this.payIn.processPayment(providerTransactionId);
    } catch (err) {
      this.log.warn(`Payrep payment ${providerTransactionId}, attempt ${job.attemptsMade + 1}: ${redactIds((err as Error).message)}`);
      throw err;
    }
  }
}
