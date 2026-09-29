import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { JOBS, QUEUES } from '../common/queues';
import { FeeClaimsService } from './fee-claims.service';

/**
 * Concurrency 1, on the background rate-limit lane.
 *
 * A claim of 400 receivables is 400+ upstream calls. Run flat out it would
 * starve live trading; run at ~30/min it finishes in half an hour and nobody
 * notices — which is right for an operation with no deadline.
 */
@Processor(QUEUES.FEE_CLAIMS, { concurrency: 1 })
export class FeeClaimsProcessor extends WorkerHost {
  private readonly log = new Logger(FeeClaimsProcessor.name);

  constructor(private readonly claims: FeeClaimsService) {
    super();
  }

  async process(job: Job<{ runId: string; receivableId: string }>): Promise<unknown> {
    if (job.name !== JOBS.CLAIM_FEE) return null;

    try {
      const outcome = await this.claims.claimOne(job.data.runId, job.data.receivableId);
      await this.claims.finaliseIfDone(job.data.runId);
      return { outcome };
    } catch (err) {
      // Isolated: one user's failure does not touch the rest of the run.
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 8)) {
        await this.claims.recordFailure(
          job.data.runId,
          job.data.receivableId,
          (err as Error).message,
        );
        await this.claims.finaliseIfDone(job.data.runId);
      }
      throw err;
    }
  }
}
