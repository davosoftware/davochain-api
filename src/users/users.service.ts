import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { dec, str } from '../common/money';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async profile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      // M12: only the KYC fields shown, never the hashes or address. The date of birth
      // (28 Oct 2026) is the verified one, from the BVN/NIN record at Basic.
      include: {
        kycProfile: { select: { rejectionReason: true, submittedAt: true, dateOfBirth: true } },
        quidaxAccount: { select: { quidaxUserId: true } },
      },
    });
    if (!user) throw new NotFoundException('User not found');

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      /** The name others send crypto to (28 Oct 2026); null until chosen. */
      payUsername: user.payUsername,
      /** Whether a transaction PIN exists (29 Oct 2026). False: show "Create your PIN" before any send, withdrawal or swap. */
      hasTransactionPin: user.transactionPinHash !== null,
      status: user.status,
      // H9: false until the emailed code is entered; deposits, withdrawals, trades and verification wait for it.
      emailVerified: user.emailVerifiedAt !== null,
      /** "YYYY-MM-DD" from the verified BVN/NIN record; null until Basic verification is approved. */
      dateOfBirth: user.kycProfile?.dateOfBirth ? user.kycProfile.dateOfBirth.toISOString().slice(0, 10) : null,
      kyc: {
        tier: user.kycTier,
        status: user.kycStatus,
        rejectionReason: user.kycProfile?.rejectionReason ?? null,
        submittedAt: user.kycProfile?.submittedAt ?? null,
      },
      // Whether the wallet side is ready. The app shows "setting up" until true.
      walletReady: Boolean(user.quidaxAccount),
      createdAt: user.createdAt,
    };
  }

  /** Balances from OUR ledger, never from Quidax. The ledger is the truth. */
  async balances(userId: string) {
    const [rows, assets] = await Promise.all([
      this.prisma.balance.findMany({ where: { userId } }),
      this.prisma.asset.findMany({
        where: { isListed: true },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);

    const byAsset = new Map(rows.map((r) => [r.assetCode, r]));

    return assets.map((asset) => {
      const row = byAsset.get(asset.code);
      const available = dec(row?.available ?? 0);
      const locked = dec(row?.locked ?? 0);
      return {
        asset: asset.code,
        name: asset.name,
        isFiat: asset.isFiat,
        available: str(available, asset.displayScale),
        locked: str(locked, asset.displayScale),
        total: str(available.plus(locked), asset.displayScale),
      };
    });
  }
}
