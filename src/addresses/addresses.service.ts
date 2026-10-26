import { BadRequestException, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AddressStatus, AlertType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuidaxClient } from '../quidax/quidax.client';
import { AssetsService } from '../assets/assets.service';
import { ProvisioningService } from '../users/provisioning.service';
import { SystemFlagsService } from '../common/system-flags.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JOBS, QUEUES, jobId } from '../common/queues';
import { JobLeaseService } from '../common/job-lease.service';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';

const HOUR = 3_600_000;
/** A PENDING address older than this gets one last check by the hourly sweep. */
const SWEEP_AFTER_MS = 2 * HOUR;

export interface AddressView {
  asset: string;
  network: string;
  networkLabel: string;
  status: AddressStatus;
  address: string | null;
  destinationTag: string | null;
  requiresTag: boolean;
  confirmations: number;
  /** False while generating, or if a required memo is missing. Gate copy/QR on it. */
  usable: boolean;
}

/**
 * One permanent address per user, per coin, per chain.
 *
 * Generation is asynchronous: the POST returns address:null and the real value
 * arrives on the wallet.address.generated webhook. Nothing may render a null
 * address — a deposit sent to a half-loaded string is gone.
 */
@Injectable()
export class AddressesService {
  private readonly log = new Logger(AddressesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly quidax: QuidaxClient,
    private readonly assets: AssetsService,
    private readonly provisioning: ProvisioningService,
    private readonly flags: SystemFlagsService,
    @InjectQueue(QUEUES.ADDRESSES) private readonly queue: Queue,
    private readonly notifications: NotificationsService,
    @Optional() private readonly leases?: JobLeaseService,
    @Optional() private readonly alerts?: OpsAlertsService,
  ) {}

  /** How long to wait between looks while another request creates the same address. */
  private waitMs = 500;

  /**
   * Get-or-create. The overwhelming majority of calls hit the existing row and
   * never touch Quidax — which is what keeps this inside the 20/sec cap.
   */
  async getOrCreate(userId: string, assetCode: string, networkId: string, opts: { auto?: boolean } = {}): Promise<AddressView> {
    await this.flags.assertDepositsAllowed();

    const code = assetCode.toLowerCase();
    await this.assets.require(code);

    const network = await this.prisma.assetNetwork.findUnique({
      where: { assetCode_networkId: { assetCode: code, networkId } },
    });
    if (!network || !network.isListed) {
      throw new NotFoundException(`${code.toUpperCase()} is not available on ${networkId}`);
    }
    if (!network.depositsEnabled) {
      throw new BadRequestException(
        `Deposits are disabled for ${code.toUpperCase()} on ${network.label}`,
      );
    }

    const existing = await this.prisma.depositAddress.findUnique({
      where: { userId_assetCode_networkId: { userId, assetCode: code, networkId } },
    });
    if (existing && existing.status !== AddressStatus.FAILED) {
      return this.toView(existing, network.label, network.requiresTag, network.confirmations);
    }

    // A6: one creation per customer, coin and network at a time, so two taps
    // never make Quidax create two addresses. The other request waits for it.
    if (!this.leases) return this.create(userId, code, networkId, network, opts.auto ?? false);
    const run = await this.leases.run(`address-${userId}-${code}-${networkId}`, 60_000, () =>
      this.create(userId, code, networkId, network, opts.auto ?? false),
    );
    if (run.ran) return run.result;
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, this.waitMs));
      const made = await this.prisma.depositAddress.findUnique({
        where: { userId_assetCode_networkId: { userId, assetCode: code, networkId } },
      });
      if (made && made.status !== AddressStatus.FAILED) {
        return this.toView(made, network.label, network.requiresTag, network.confirmations);
      }
    }
    throw new ServiceUnavailableException('Your address is still being created. Try again in a moment.');
  }

  private async create(
    userId: string,
    code: string,
    networkId: string,
    network: { label: string; requiresTag: boolean; confirmations: number },
    auto: boolean,
  ): Promise<AddressView> {
    // Re-read inside the lease: another request may have just finished.
    const already = await this.prisma.depositAddress.findUnique({
      where: { userId_assetCode_networkId: { userId, assetCode: code, networkId } },
    });
    if (already && already.status !== AddressStatus.FAILED) {
      return this.toView(already, network.label, network.requiresTag, network.confirmations);
    }

    // Try again after FAILED (spec 2026-10-26): Quidax may have finished late.
    // Only if it has nothing do we ask for a new address, so a tap never wastes one.
    if (already) {
      const late = await this.resolve(already.id);
      if (late?.address) return late;
    }

    const quidaxUserId = await this.provisioning.requireQuidaxId(userId);
    const created = await this.quidax.createPaymentAddress(quidaxUserId, code, networkId);

    const row = await this.prisma.depositAddress.upsert({
      where: { userId_assetCode_networkId: { userId, assetCode: code, networkId } },
      create: {
        userId,
        assetCode: code,
        networkId,
        quidaxAddressId: created.id,
        address: created.address, // usually null — generation is async
        destinationTag: created.destination_tag,
        status: created.address ? AddressStatus.ACTIVE : AddressStatus.PENDING,
        activatedAt: created.address ? new Date() : null,
        autoCreated: auto,
      },
      update: {
        quidaxAddressId: created.id,
        status: created.address ? AddressStatus.ACTIVE : AddressStatus.PENDING,
        address: created.address,
        destinationTag: created.destination_tag,
        requestedAt: new Date(),
        failedAt: null,
        // A customer's own tap makes it theirs: they get the "address ready" message.
        autoCreated: auto && (already?.autoCreated ?? true),
      },
    });

    // Backstop for a lost webhook. Quidax stops retrying after five attempts.
    if (!row.address) {
      await this.queue.add(
        JOBS.POLL_ADDRESS,
        { addressId: row.id },
        { delay: 15_000, jobId: jobId('poll', row.id, Date.now()) },
      );
    }

    return this.toView(row, network.label, network.requiresTag, network.confirmations);
  }

  async listForUser(userId: string): Promise<AddressView[]> {
    const rows = await this.prisma.depositAddress.findMany({
      where: { userId },
      include: { network: true },
      orderBy: [{ assetCode: 'asc' }, { networkId: 'asc' }],
    });
    return rows.map((r) =>
      this.toView(r, r.network.label, r.network.requiresTag, r.network.confirmations),
    );
  }

  /**
   * Resolve a PENDING address. Called by the webhook handler and by the poller;
   * whichever wins, the other is a no-op.
   */
  async resolve(addressId: string): Promise<AddressView | null> {
    const row = await this.prisma.depositAddress.findUnique({
      where: { id: addressId },
      include: { network: true },
    });
    if (!row) return null;
    if (row.address) {
      return this.toView(
        row,
        row.network.label,
        row.network.requiresTag,
        row.network.confirmations,
      );
    }

    const quidaxUserId = await this.provisioning.requireQuidaxId(row.userId);
    const upstream = await this.quidax.fetchPaymentAddresses(quidaxUserId, row.assetCode);
    const match =
      upstream.find((a) => a.id === row.quidaxAddressId) ??
      upstream.find((a) => (a.network ?? row.networkId) === row.networkId && a.address);

    if (!match?.address) return null;

    return this.applyGenerated(row.id, match.address, match.destination_tag ?? null);
  }

  /** Shared by the webhook and the poller. Idempotent. */
  async applyGenerated(
    addressId: string,
    address: string,
    destinationTag: string | null,
  ): Promise<AddressView> {
    const updated = await this.prisma.depositAddress.update({
      where: { id: addressId },
      data: {
        address,
        destinationTag,
        status: AddressStatus.ACTIVE,
        activatedAt: new Date(),
        failedAt: null,
      },
      include: { network: true },
    });
    this.log.log(`Address ready: ${updated.assetCode}/${updated.networkId} for ${updated.userId}`);

    /*
     * The one place an address becomes usable, so the one place to say so.
     *
     * Generation is asynchronous and can take a minute. A user who asked for an
     * address and then closed the app has no way of finding out it arrived —
     * the poll they were relying on stopped when the screen did.
     */
    // Made in advance (spec 2026-10-26): the customer didn't ask, so no message.
    if (!updated.autoCreated) await this.notifications.notify({
      userId: updated.userId,
      type: 'address.ready',
      title: `${updated.assetCode.toUpperCase()} address ready`,
      body: `Your ${updated.assetCode.toUpperCase()} deposit address on ${updated.network.label} is ready to use.`,
      email: {
        key: 'address.ready',
        variables: {
          assetCode: updated.assetCode.toUpperCase(),
          networkLabel: updated.network.label,
          address,
          // Em dash rather than blank: "Tag: " with nothing after it reads as a
          // missing value on a chain where a missing tag loses the deposit.
          destinationTag: destinationTag ?? '—',
        },
      },
    });

    return this.toView(
      updated,
      updated.network.label,
      updated.network.requiresTag,
      updated.network.confirmations,
    );
  }

  /**
   * Give up on an address Quidax never delivered (spec 2026-10-26): FAILED, a
   * person is alerted, and the customer is told to try again. Only a row that is
   * still PENDING without an address changes, so a late arrival is never undone.
   */
  async markFailed(addressId: string): Promise<boolean> {
    const { count } = await this.prisma.depositAddress.updateMany({
      where: { id: addressId, status: AddressStatus.PENDING, address: null },
      data: { status: AddressStatus.FAILED, failedAt: new Date() },
    });
    if (count === 0) return false;

    const row = await this.prisma.depositAddress.findUnique({ where: { id: addressId }, include: { network: true } });
    if (!row) return true;
    const coin = row.assetCode.toUpperCase();
    this.log.error(`Address ${addressId} (${coin}/${row.networkId}) never arrived from Quidax: marked FAILED`);

    await this.alerts?.raise(
      AlertType.CRYPTO_ADDRESS_STUCK,
      `address:${addressId}`,
      `A ${coin} deposit address never arrived from Quidax`,
      [
        `Coin and network: ${coin} on ${row.network.label}`,
        `Customer: ${row.userId}`,
        `Asked for: ${row.requestedAt.toISOString()}`,
        row.autoCreated ? 'Made in advance (the customer did not ask yet).' : 'The customer asked for it and was told to try again.',
        'Open: /crypto-addresses?stuck=true (Try again there, or check the sub-account at Quidax).',
      ],
      24 * HOUR,
    );

    if (!row.autoCreated) {
      await this.notifications.notify({
        userId: row.userId,
        type: 'address.failed',
        title: `${coin} address not ready`,
        body: `We couldn't create your ${coin} address. Open Receive to try again.`,
      });
    }
    return true;
  }

  /**
   * Hourly: PENDING addresses whose checker was lost (e.g. with Redis) get one
   * last look at Quidax; if still nothing, they fail like the checker would.
   */
  async sweepStuck(now = new Date()): Promise<{ checked: number; failed: number }> {
    const rows = await this.prisma.depositAddress.findMany({
      where: { status: AddressStatus.PENDING, address: null, requestedAt: { lt: new Date(now.getTime() - SWEEP_AFTER_MS) } },
      select: { id: true },
      take: 100,
    });
    let failed = 0;
    for (const { id } of rows) {
      const found = await this.resolve(id).catch((err) => {
        this.log.warn(`Sweep could not check address ${id}: ${(err as Error).message}`);
        return undefined;
      });
      if (found === undefined) continue; // Quidax unreachable: try again next hour
      if (!found?.address && (await this.markFailed(id))) failed++;
    }
    return { checked: rows.length, failed };
  }

  /** Match an inbound webhook to a stored row when we only know the address. */
  async findByAddress(address: string) {
    return this.prisma.depositAddress.findFirst({ where: { address } });
  }

  private toView(
    row: {
      assetCode: string;
      networkId: string;
      status: AddressStatus;
      address: string | null;
      destinationTag: string | null;
    },
    networkLabel: string,
    requiresTag: boolean,
    confirmations: number,
  ): AddressView {
    return {
      asset: row.assetCode,
      network: row.networkId,
      networkLabel,
      status: row.status,
      address: row.address,
      destinationTag: row.destinationTag,
      requiresTag,
      confirmations,
      // Two failure modes cost users real money: rendering a null address, and
      // omitting a required memo. Both are gated here rather than in the UI.
      usable:
        row.status === AddressStatus.ACTIVE &&
        Boolean(row.address) &&
        (!requiresTag || Boolean(row.destinationTag)),
    };
  }
}
