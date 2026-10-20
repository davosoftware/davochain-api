import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { AddressesService } from '../addresses/addresses.service';
import { ProvisioningService } from '../users/provisioning.service';
import { DepositsService } from '../deposits/deposits.service';
import { SettlementService } from '../trades/settlement.service';
import { JOBS, QUEUES } from '../common/queues';
import { QuidaxEventConfirmer } from './quidax-event-confirmer';
import type {
  QuidaxDeposit,
  QuidaxPaymentAddress,
  QuidaxSwapTransaction,
  QuidaxUser,
  QuidaxWithdrawal,
} from '../quidax/quidax.types';

interface Envelope {
  event: string;
  data: Record<string, unknown> & { user?: QuidaxUser | null };
}

@Injectable()
@Processor(QUEUES.WEBHOOKS, { concurrency: 5 })
export class WebhooksProcessor extends WorkerHost {
  private readonly log = new Logger(WebhooksProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly addresses: AddressesService,
    private readonly provisioning: ProvisioningService,
    private readonly deposits: DepositsService,
    private readonly settlement: SettlementService,
    private readonly confirm: QuidaxEventConfirmer,
  ) {
    super();
  }

  async process(job: Job<{ webhookEventId: string }>): Promise<unknown> {
    if (job.name !== JOBS.PROCESS_WEBHOOK) return null;

    const event = await this.prisma.webhookEvent.findUnique({
      where: { id: job.data.webhookEventId },
    });
    if (!event || event.processedAt) return { skipped: true };

    const envelope = event.payload as unknown as Envelope;

    try {
      await this.dispatch(envelope);
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date(), attempts: { increment: 1 } },
      });
      return { handled: envelope.event };
    } catch (err) {
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { attempts: { increment: 1 }, lastError: (err as Error).message.slice(0, 1000) },
      });
      throw err; // let BullMQ retry with backoff
    }
  }

  private async dispatch(envelope: Envelope): Promise<void> {
    switch (envelope.event) {
      case 'wallet.address.generated':
        return this.onAddressGenerated(envelope.data as unknown as QuidaxPaymentAddress);

      case 'deposit.transaction.confirmation':
      case 'deposit.successful':
      case 'deposit.on_hold':
      case 'deposit.failed_aml':
      case 'deposit.rejected': {
        // A1: credited from Quidax's own record, never the message's.
        const real = await this.confirm.deposit(envelope.data as unknown as QuidaxDeposit);
        if (real) await this.deposits.applyWebhook(envelope.event, real);
        return;
      }

      case 'withdraw.successful':
      case 'withdraw.rejected': {
        // A1: a "rejected" message never refunds money Quidax says it sent.
        const real = await this.confirm.withdrawal(envelope.data as unknown as QuidaxWithdrawal);
        if (real) await this.settlement.applyWithdrawalWebhook(real.event, real.data);
        return;
      }

      case 'swap_transaction.complete':
      case 'swap_transaction.failed': {
        const real = await this.confirm.swap(envelope.data as unknown as QuidaxSwapTransaction);
        if (real) await this.settlement.applySwapWebhook(real.event, real.data);
        return;
      }

      case 'wallet.updated':
        // Reconciliation signal only. NEVER credit a user from this — it
        // carries a balance, not a transaction, and crediting from a balance
        // double-counts the moment two events arrive out of order.
        return;

      default:
        this.log.warn(`Unhandled webhook event: ${envelope.event}`);
    }
  }

  private async onAddressGenerated(data: QuidaxPaymentAddress): Promise<void> {
    if (!data.address) return;

    const row =
      (data.id
        ? await this.prisma.depositAddress.findFirst({ where: { quidaxAddressId: data.id } })
        : null) ?? (await this.addresses.findByAddress(data.address));

    // A1: the address comes from Quidax's list of this customer's addresses,
    // never from the message: a forged message must not show a customer
    // somebody else's address to pay into.
    if (row) {
      await this.addresses.resolve(row.id);
      return;
    }

    // Fall back to matching on the user, since the address id may be new to us.
    const userId = await this.resolveUser(data.user ?? null);
    if (!userId) {
      this.log.warn(`address.generated for an unknown user: ${data.address}`);
      return;
    }
    const pending = await this.prisma.depositAddress.findFirst({
      where: { userId, assetCode: data.currency.toLowerCase(), address: null },
    });
    if (pending) {
      await this.addresses.resolve(pending.id);
    }
  }

  /**
   * Resolve in order: quidax id, then sn.
   *
   * The documented swap_transaction.complete payload ships `user.id` as NULL
   * with only `sn` populated, so a handler keying purely on the id drops those
   * events on the floor.
   */
  private async resolveUser(user: QuidaxUser | null): Promise<string | null> {
    if (!user) return null;
    return this.provisioning.findUserByQuidax({
      quidaxUserId: user.id,
      quidaxSn: user.sn,
    });
  }
}
