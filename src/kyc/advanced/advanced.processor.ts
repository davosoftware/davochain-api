import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { JOBS, QUEUES } from '../../common/queues';
import { AdvancedRunner } from './advanced-runner.service';

/** Runs Advanced attempts off the request (spec 2026-10-21 §6). A thrown error is a BullMQ retry. */
@Processor(QUEUES.KYC_ADVANCED, { concurrency: 3 })
export class AdvancedProcessor extends WorkerHost {
  private readonly log = new Logger(AdvancedProcessor.name);

  constructor(private readonly runner: AdvancedRunner) {
    super();
  }

  async process(job: Job<{ id: string }>): Promise<null> {
    if (job.name !== JOBS.RUN_ADVANCED) return null;
    await this.runner.run(job.data.id);
    this.log.log(`advanced ${job.data.id}: ran`);
    return null;
  }
}
