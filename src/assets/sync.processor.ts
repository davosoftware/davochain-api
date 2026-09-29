import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { JOBS, QUEUES, jobId } from '../common/queues';
import { AssetsService } from './assets.service';

@Processor(QUEUES.SYNC, { concurrency: 1 })
export class SyncProcessor extends WorkerHost {
  private readonly log = new Logger(SyncProcessor.name);

  constructor(
    private readonly assets: AssetsService,
    @InjectQueue(QUEUES.SYNC) private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job<{ assetCode?: string }>): Promise<unknown> {
    if (job.name !== JOBS.SYNC_NETWORKS) return null;
    if (job.data.assetCode) return this.assets.syncNetworks(job.data.assetCode);
    const result = await this.assets.syncAll();
    this.log.log(`Chain sync complete: ${Object.keys(result).length} assets`);
    return result;
  }

  /** Nightly. Chain availability changes without notice — Arbitrum is the proof. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async nightly(): Promise<void> {
    await this.queue.add(
      JOBS.SYNC_NETWORKS,
      {},
      { jobId: jobId('sync', new Date().toISOString().slice(0, 10)) },
    );
  }
}
