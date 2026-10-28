import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job } from 'bullmq';
import { JOBS, QUEUES } from '../common/queues';
import { BroadcastsService } from './broadcasts.service';

/**
 * Runs admin broadcasts (29 Oct 2026), one at a time per server, wave by
 * wave, off the request. Its own queue, so a 3-hour send never sits in front
 * of a trade's push notification.
 */
@Processor(QUEUES.BROADCASTS, { concurrency: 1, lockDuration: 60_000 })
export class BroadcastsProcessor extends WorkerHost {
  constructor(private readonly broadcasts: BroadcastsService) {
    super();
  }

  async process(job: Job<{ broadcastId: string }>): Promise<unknown> {
    if (job.name !== JOBS.RUN_BROADCAST) return null;
    await this.broadcasts.run(job.data.broadcastId);
    return null;
  }
}

/** After a restart or deploy, carry on with any broadcast that was queued or sending. */
@Injectable()
export class BroadcastsRecovery implements OnApplicationBootstrap {
  private readonly log = new Logger(BroadcastsRecovery.name);

  constructor(private readonly broadcasts: BroadcastsService) {}

  onApplicationBootstrap(): void {
    void this.broadcasts
      .recover()
      .then((n) => n && this.log.log(`Carrying on with ${n} broadcast(s) after start-up`))
      .catch((err: Error) => this.log.error(`Could not resume broadcasts: ${err.message}`));
  }
}
