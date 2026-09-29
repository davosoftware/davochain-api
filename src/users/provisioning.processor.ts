import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { JOBS, QUEUES } from '../common/queues';
import { ProvisioningService } from './provisioning.service';

@Processor(QUEUES.PROVISIONING, { concurrency: 2 })
export class ProvisioningProcessor extends WorkerHost {
  private readonly log = new Logger(ProvisioningProcessor.name);

  constructor(private readonly provisioning: ProvisioningService) {
    super();
  }

  async process(job: Job<{ userId: string }>): Promise<unknown> {
    if (job.name !== JOBS.PROVISION_SUBACCOUNT) return null;
    const { created } = await this.provisioning.provision(job.data.userId);
    this.log.log(`${job.data.userId}: ${created ? 'provisioned' : 'already provisioned'}`);
    return { created };
  }
}
