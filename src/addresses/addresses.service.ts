import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AddressStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuidaxClient } from '../quidax/quidax.client';
import { AssetsService } from '../assets/assets.service';
import { ProvisioningService } from '../users/provisioning.service';
import { SystemFlagsService } from '../common/system-flags.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JOBS, QUEUES, jobId } from '../common/queues';

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
  ) {}

  /**
   * Get-or-create. The overwhelming majority of calls hit the existing row and
   * never touch Quidax — which is what keeps this inside the 20/sec cap.
   */
  async getOrCreate(userId: string, assetCode: string, networkId: string): Promise<AddressView> {
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
      },
      update: {
        quidaxAddressId: created.id,
        status: created.address ? AddressStatus.ACTIVE : AddressStatus.PENDING,
        address: created.address,
        destinationTag: created.destination_tag,
        requestedAt: new Date(),
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
    await this.notifications.notify({
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
