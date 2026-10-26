import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { KycStatus, KycTier, PolicyAction, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemFlagsService } from '../common/system-flags.service';
import { JobLeaseService } from '../common/job-lease.service';
import { redactIds } from '../common/redact';
import { levelOf } from '../levels/levels';
import { ServerSettingsService } from '../settings/server-settings.service';
import { AddressesService } from './addresses.service';

const MINUTE = 60_000;
/** Customers per run. Quidax limits how fast we may ask for addresses, so a steady trickle beats a burst. */
const BATCH = 20;
/** A customer whose address could not be asked for is left alone this long. */
const BACK_OFF_MS = 60 * MINUTE;
const TIERS = [KycTier.TIER_1, KycTier.TIER_2, KycTier.TIER_3];

/**
 * Addresses made in advance (spec 2026-10-26 part 3).
 *
 * Every minute, verified customers get an address for each coin network that is
 * switched on for it ("Create in advance" on the Crypto addresses page), without
 * opening Receive. Customers verified before this existed are filled in at the
 * same steady pace. All the safety lives in AddressesService.getOrCreate (one
 * creation at a time, never a second address). A FAILED one is not retried
 * here: the alert asks a person to look.
 *
 * Also runs the hourly sweep of stuck PENDING addresses (part 1).
 */
@Injectable()
export class AddressMakerService {
  private readonly log = new Logger(AddressMakerService.name);
  /** userId → when to try again, after Quidax refused or failed. One server runs this (lease). */
  private readonly backOff = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly addresses: AddressesService,
    private readonly flags: SystemFlagsService,
    private readonly leases: JobLeaseService,
    /** CRYPTO_ADDRESS_AUTO_CREATE: off for a test server. */
    @Optional() private readonly settings?: ServerSettingsService,
  ) {}

  @Cron('* * * * *', { name: 'crypto-address-maker' })
  async cron(): Promise<void> {
    try {
      await this.leases.run('crypto-address-maker', 5 * MINUTE, () => this.run());
    } catch (err) {
      this.log.error(`Address maker failed: ${redactIds((err as Error).message)}`);
    }
  }

  @Cron('17 * * * *', { name: 'crypto-address-sweep' })
  async sweep(): Promise<void> {
    try {
      await this.leases.run('crypto-address-sweep', 30 * MINUTE, async () => {
        const r = await this.addresses.sweepStuck();
        if (r.checked) this.log.log(`Stuck address sweep: ${r.checked} checked, ${r.failed} marked failed`);
      });
    } catch (err) {
      this.log.error(`Stuck address sweep failed: ${redactIds((err as Error).message)}`);
    }
  }

  async run(now = Date.now()): Promise<{ customers: number; made: number }> {
    const none = { customers: 0, made: 0 };
    if (this.settings?.get<boolean>('CRYPTO_ADDRESS_AUTO_CREATE') === false) return none;
    try {
      await this.flags.assertDepositsAllowed();
    } catch {
      return none; // crypto deposits paused, or maintenance
    }

    const networks = await this.prisma.assetNetwork.findMany({
      where: { autoCreate: true, isListed: true, depositsEnabled: true },
      select: { assetCode: true, networkId: true },
    });
    if (networks.length === 0) return none;

    // The same rule as the Receive screen: the level must allow crypto deposits.
    const levels = new Set(
      (await this.prisma.levelRule.findMany({ where: { action: PolicyAction.CRYPTO_DEPOSIT, allowed: true }, select: { level: true } })).map((r) => r.level),
    );
    const tiers = TIERS.filter((t) => levels.has(levelOf(t)));
    if (tiers.length === 0) return none;

    for (const [id, until] of this.backOff) if (until <= now) this.backOff.delete(id);
    const skip = [...this.backOff.keys()];

    const users = await this.prisma.user.findMany({
      where: {
        status: UserStatus.ACTIVE,
        kycStatus: KycStatus.APPROVED,
        amlStatus: 'CLEAR',
        emailVerifiedAt: { not: null },
        kycTier: { in: tiers },
        quidaxAccount: { isNot: null },
        ...(skip.length ? { id: { notIn: skip } } : {}),
        // Missing at least one of them (any status counts as having it, FAILED too).
        OR: networks.map((n) => ({ addresses: { none: { assetCode: n.assetCode, networkId: n.networkId } } })),
      },
      select: { id: true, addresses: { select: { assetCode: true, networkId: true } } },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    });

    let made = 0;
    for (const user of users) {
      const have = new Set(user.addresses.map((a) => `${a.assetCode}/${a.networkId}`));
      for (const n of networks) {
        if (have.has(`${n.assetCode}/${n.networkId}`)) continue;
        try {
          await this.addresses.getOrCreate(user.id, n.assetCode, n.networkId, { auto: true });
          made++;
        } catch (err) {
          this.backOff.set(user.id, now + BACK_OFF_MS);
          this.log.warn(`Could not make ${n.assetCode}/${n.networkId} in advance for a customer: ${redactIds((err as Error).message)}`);
          break;
        }
      }
    }
    return { customers: users.length, made };
  }
}
