import { avatarKey } from '../avatars/avatars.service';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomBytes } from 'node:crypto';
import { Prisma, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FILE_STORE, FileStore } from '../storage/file-store';
import { JobLeaseService } from '../common/job-lease.service';

const REDACTED = { redacted: 'customer data deleted' } as const;
const DELETED_NAME = 'Deleted customer';

/**
 * Deleting a closed customer's data (decisions 28 Oct 2026): straight away, or
 * on the day the closing owner chose ("delete after N months", run by a daily
 * job).
 *
 * Everything that identifies the person is deleted: name, email, phone, date
 * of birth, address, BVN/NIN, ID photos and selfies, gift card photos,
 * verification and screening records, saved destinations' details, devices,
 * notifications. The money records (transactions, ledger, balances, fees,
 * referrals, gift card sales) are NOT deleted: the other half of every entry
 * is in DavoChain's own accounts, so removing them would break the books and
 * the reconciliation with Quidax. They stay linked to a "Deleted customer" row.
 */
@Injectable()
export class CustomerErasureService {
  private readonly log = new Logger(CustomerErasureService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORE) private readonly store: FileStore,
    @Optional() private readonly leases?: JobLeaseService,
  ) {}

  @Cron('15 4 * * *', { name: 'closed-account-data-deletion' })
  async cron(): Promise<void> {
    try {
      const run = () => this.runDue();
      if (this.leases) await this.leases.run('closed-account-data-deletion', 30 * 60 * 1000, run);
      else await run();
    } catch (err) {
      this.log.error(`Closed-account data deletion failed: ${(err as Error).message}`);
    }
  }

  /** The daily job: every closed account whose deletion day has come. */
  async runDue(now: Date = new Date()): Promise<{ erased: number; failed: number }> {
    const due = await this.prisma.user.findMany({
      where: { status: UserStatus.CLOSED, dataDeletedAt: null, dataDeleteAt: { lte: now } },
      select: { id: true, closedBy: true },
      take: 200,
    });
    let erased = 0;
    let failed = 0;
    for (const u of due) {
      try {
        // Recorded under the owner who chose "delete later" when closing.
        const r = await this.erase(u.id, { adminId: u.closedBy ?? '', scheduled: true });
        if (r.erased) erased++;
      } catch (err) {
        failed++;
        this.log.error(`Could not delete the data of closed account ${u.id}: ${(err as Error).message}`);
      }
    }
    if (erased || failed) this.log.log(`Closed-account data deletion: ${erased} deleted, ${failed} failed`);
    return { erased, failed };
  }

  async erase(userId: string, by: { adminId: string; scheduled: boolean }): Promise<{ erased: boolean; files: number }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.status !== UserStatus.CLOSED) throw new BadRequestException('Only a closed account can have its data deleted.');
    if (user.dataDeletedAt) return { erased: false, files: 0 };

    // The files are listed before their rows go, and removed after the commit.
    const [docs, cardPhotos] = await Promise.all([
      this.prisma.kycDocument.findMany({ where: { profile: { userId } }, select: { storageKey: true } }),
      this.prisma.giftCardTradeImage.findMany({ where: { trade: { userId } }, select: { storageKey: true } }),
    ]);
    const keys = [...docs, ...cardPhotos].map((f) => f.storageKey).filter((k): k is string => !!k);
    // The profile photo (29 Oct 2026).
    if (user.avatarId) keys.push(avatarKey(user.avatarId));
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      // Identity and verification.
      await tx.kycDocument.deleteMany({ where: { profile: { userId } } });
      await tx.kycProfile.updateMany({
        where: { userId },
        data: {
          dateOfBirth: null, bvnHash: null, bvnLast4: null, ninHash: null, ninLast4: null,
          addressLine: null, city: null, state: null, lga: null, postcode: null, stateOfOrigin: null,
          providerRef: null, rejectionReason: null,
        },
      });
      await tx.advancedVerification.deleteMany({ where: { userId } });
      await tx.kycVerification.deleteMany({ where: { userId } });
      // A case points at its screening, so cases go first.
      await tx.amlReviewCase.deleteMany({ where: { userId } });
      await tx.amlScreening.deleteMany({ where: { userId } });

      // Photos of gift cards sold; the sales themselves are money records and stay.
      await tx.giftCardTradeImage.deleteMany({ where: { trade: { userId } } });

      // Past withdrawals point at these rows, so they are blanked rather than removed.
      await tx.savedBankAccount.updateMany({ where: { userId, removedAt: null }, data: { removedAt: now } });
      await tx.savedBankAccount.updateMany({ where: { userId }, data: { accountNumber: '**********', accountName: DELETED_NAME, nickname: null } });
      await tx.savedCryptoAddress.updateMany({ where: { userId, removedAt: null }, data: { removedAt: now } });
      await tx.savedCryptoAddress.updateMany({ where: { userId }, data: { address: '[deleted]', destinationTag: null, nickname: null } });
      await tx.virtualAccount.updateMany({ where: { userId }, data: { accountName: DELETED_NAME } });
      await tx.virtualAccountRequest.deleteMany({ where: { userId } });

      // Everything else about the person.
      await tx.notification.deleteMany({ where: { userId } });
      await tx.deviceToken.deleteMany({ where: { userId } });
      await tx.userOtp.deleteMany({ where: { userId } });
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.idempotencyKey.deleteMany({ where: { userId } });
      await tx.payUsernameHold.deleteMany({ where: { userId } });

      await tx.user.update({
        where: { id: userId },
        data: {
          firstName: 'Deleted',
          lastName: 'customer',
          email: `deleted-${userId}@deleted.davochain`,
          phone: null,
          closedEmail: null,
          closedPhone: null,
          closedReason: 'Personal data deleted',
          suspendedReason: null,
          username: null,
          payUsername: null,
          payUsernameSetAt: null,
          transactionPinHash: null,
          transactionPinSetAt: null,
          pinFailedCount: 0,
          pinLockedUntil: null,
          avatarId: null,
          avatarUpdatedAt: null,
          referralCode: null,
          // Can never match a password.
          passwordHash: `!deleted-${randomBytes(16).toString('hex')}`,
          dataDeleteAt: null,
          dataDeletedAt: now,
        },
      });

      // The audit trail keeps what was done and by whom, not the person's details.
      await tx.adminAuditLog.updateMany({
        where: { entity: 'User', entityId: userId },
        data: { before: REDACTED as Prisma.InputJsonValue, after: REDACTED as Prisma.InputJsonValue },
      });
      await tx.adminAuditLog.create({
        data: {
          adminUserId: by.adminId,
          action: 'user.erase',
          entity: 'User',
          entityId: userId,
          before: Prisma.JsonNull,
          after: { scheduled: by.scheduled } as Prisma.InputJsonValue,
          ip: null,
        },
      });
    });

    // After the commit. A file that can't be removed now is logged, never a reason to undo.
    for (const key of keys) {
      await this.store.delete(key).catch((e: Error) => this.log.warn(`Could not delete file ${key}: ${e.message}`));
    }
    return { erased: true, files: keys.length };
  }
}
