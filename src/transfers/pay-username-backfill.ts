import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { JobLeaseService } from '../common/job-lease.service';
import { PayUsernamesService } from './pay-usernames.service';

/**
 * Every open account gets a payment username (decision 28 Oct 2026): the
 * customers who signed up before the feature, the rare sign-up whose own step
 * failed, and anyone whose name an admin removed. Runs once at start-up, so a
 * deploy covers everyone at once, then hourly. One server at a time.
 */
@Injectable()
export class PayUsernameBackfill implements OnApplicationBootstrap {
  private readonly log = new Logger(PayUsernameBackfill.name);

  constructor(
    private readonly usernames: PayUsernamesService,
    @Optional() private readonly leases?: JobLeaseService,
  ) {}

  onApplicationBootstrap(): void {
    // Not awaited: start-up must never wait on, or fail because of, this.
    void this.run();
  }

  @Cron('7 * * * *', { name: 'pay-username-backfill' })
  async run(): Promise<void> {
    try {
      const go = () => this.usernames.backfill();
      let given = 0;
      if (this.leases) {
        const lease = await this.leases.run('pay-username-backfill', 30 * 60 * 1000, go);
        given = lease.ran ? lease.result : 0;
      } else {
        given = await go();
      }
      if (given) this.log.log(`Payment usernames given to ${given} customer(s)`);
    } catch (err) {
      this.log.error(`Payment username backfill failed: ${(err as Error).message}`);
    }
  }
}
