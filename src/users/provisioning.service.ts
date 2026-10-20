import { Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { AlertType } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { QuidaxClient } from '../quidax/quidax.client';
import { QuidaxError } from '../quidax/quidax.errors';
import { JOBS, QUEUES, jobId } from '../common/queues';
import { JobLeaseService } from '../common/job-lease.service';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';

/**
 * Creates the Quidax sub-account behind a user.
 *
 * On a worker, never inline in the signup request: a signup must not fail
 * because an upstream call did, and the user has nothing to do with a wallet
 * until they reach the crypto page anyway.
 *
 * The email is IRREVERSIBLE. Quidax emails are unique and immutable, and there
 * is no delete endpoint — every account permanently burns an address on the
 * live merchant account. So we send an alias, never the user's real address,
 * and non-production accounts carry a distinct domain so they can be filtered
 * out of every report that will ever be written.
 */
@Injectable()
export class ProvisioningService {
  private readonly log = new Logger(ProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly quidax: QuidaxClient,
    private readonly config: ConfigService,
    @InjectQueue(QUEUES.PROVISIONING) private readonly queue: Queue,
    @Optional() private readonly leases?: JobLeaseService,
    @Optional() private readonly alerts?: OpsAlertsService,
  ) {}

  /** How long to wait between looks while another server creates the account. */
  private waitMs = 500;

  /** Queue provisioning. Safe to call repeatedly — the job is idempotent. */
  async enqueue(userId: string): Promise<void> {
    await this.queue.add(
      JOBS.PROVISION_SUBACCOUNT,
      { userId },
      { jobId: jobId('provision', userId) }, // dedupes a double signup callback
    );
  }

  aliasEmail(userId: string, isTest: boolean): string {
    const domain = isTest
      ? this.config.getOrThrow<string>('TEST_ALIAS_EMAIL_DOMAIN')
      : this.config.getOrThrow<string>('USER_ALIAS_EMAIL_DOMAIN');
    return `${isTest ? 't' : 'u'}_${userId}@${domain}`;
  }

  /**
   * Idempotent. Returns the existing account if one is already linked, so a
   * retry after a timeout cannot create a second sub-account for the user —
   * which would be permanent and unfixable.
   */
  /**
   * A3: one creation per customer at a time, across every server. Quidax
   * sub-accounts can never be deleted, so the sign-up job and the on-demand
   * path ("Receive" before the job ran) must never both create one. The loser
   * waits for the winner's account instead.
   */
  async provision(userId: string): Promise<{ quidaxUserId: string; created: boolean }> {
    const existing = await this.prisma.quidaxAccount.findUnique({ where: { userId } });
    if (existing) return { quidaxUserId: existing.quidaxUserId, created: false };
    if (!this.leases) return this.create(userId);

    const run = await this.leases.run(`provision-${userId}`, 60_000, () => this.create(userId));
    if (run.ran) return run.result;

    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, this.waitMs));
      const made = await this.prisma.quidaxAccount.findUnique({ where: { userId } });
      if (made) return { quidaxUserId: made.quidaxUserId, created: false };
    }
    throw new ServiceUnavailableException('Your wallet is still being set up. Try again in a moment.');
  }

  private async create(userId: string): Promise<{ quidaxUserId: string; created: boolean }> {
    const existing = await this.prisma.quidaxAccount.findUnique({ where: { userId } });
    if (existing) return { quidaxUserId: existing.quidaxUserId, created: false };

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const aliasEmail = this.aliasEmail(user.id, user.isTest);

    try {
      const account = await this.quidax.createSubAccount({
        email: aliasEmail,
        first_name: user.firstName,
        last_name: user.lastName,
      });

      await this.prisma.quidaxAccount.create({
        data: {
          userId: user.id,
          quidaxUserId: account.id ?? '',
          quidaxSn: account.sn,
          aliasEmail,
        },
      });

      this.log.log(`Provisioned ${user.id} -> quidax ${account.id}`);
      return { quidaxUserId: account.id ?? '', created: true };
    } catch (err) {
      // If the alias already exists upstream, a previous attempt succeeded and
      // we lost the response. Recover by looking it up rather than creating a
      // second account — an orphaned sub-account can never be deleted.
      if (err instanceof QuidaxError && /exist|taken|unique/i.test(err.message)) {
        // A3: the account exists at Quidax but we never recorded it (an earlier
        // answer was lost). Our Quidax client cannot look it up by email, so an
        // owner links it by hand; until then this customer has no wallet.
        this.log.error(`Alias ${aliasEmail} already exists at Quidax but is not recorded for ${user.id}`);
        await this.alerts
          ?.raise(AlertType.RECONCILIATION_DRIFT, `quidax-account:${user.id}`, 'A Quidax sub-account already exists but is not recorded', [
            `Customer: ${user.id}`,
            `Alias email at Quidax: ${aliasEmail}`,
            'Find this sub-account in the Quidax dashboard and record its id for the customer (quidax_accounts).',
          ])
          .catch(() => undefined);
        throw err;
      }
      throw err;
    }
  }

  /** The Quidax id for a user, provisioning on demand if the worker has not run. */
  async requireQuidaxId(userId: string): Promise<string> {
    const account = await this.prisma.quidaxAccount.findUnique({ where: { userId } });
    if (account) return account.quidaxUserId;
    const { quidaxUserId } = await this.provision(userId);
    return quidaxUserId;
  }

  /** Reverse lookup for webhooks, where `data.user.id` is sometimes null. */
  async findUserByQuidax(identifiers: {
    quidaxUserId?: string | null;
    quidaxSn?: string | null;
  }): Promise<string | null> {
    if (identifiers.quidaxUserId) {
      const byId = await this.prisma.quidaxAccount.findUnique({
        where: { quidaxUserId: identifiers.quidaxUserId },
        select: { userId: true },
      });
      if (byId) return byId.userId;
    }
    if (identifiers.quidaxSn) {
      const bySn = await this.prisma.quidaxAccount.findFirst({
        where: { quidaxSn: identifiers.quidaxSn },
        select: { userId: true },
      });
      if (bySn) return bySn.userId;
    }
    return null;
  }
}
