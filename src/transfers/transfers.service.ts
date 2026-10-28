import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PolicyAction, TxStatus, TxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AssetsService } from '../assets/assets.service';
import { RatesService } from '../rates/rates.service';
import { LevelPolicyService } from '../levels/level-policy.service';
import { SystemFlagsService } from '../common/system-flags.service';
import { PeerSendService } from '../withdrawals/peer-send.service';
import { SavedDestinationsService } from '../withdrawals/saved-destinations.service';
import { positiveAmount } from '../withdrawals/withdrawals.service';
import { levelOf } from '../levels/levels';
import { dec } from '../common/money';
import { PayUsernamesService } from './pay-usernames.service';
import { displayName } from './pay-username';

/** A first send to someone worth this much naira or more needs the password again. */
export const FIRST_SEND_PASSWORD_NGN = 100_000;

/**
 * Send crypto to a DavoChain customer by payment username (28 Oct 2026).
 * The money moves through PeerSendService, the same engine as a send to a
 * DavoChain address: free, instant, credited once, the sender's withdrawal
 * limits applied.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assets: AssetsService,
    private readonly rates: RatesService,
    private readonly policy: LevelPolicyService,
    private readonly flags: SystemFlagsService,
    private readonly usernames: PayUsernamesService,
    private readonly peers: PeerSendService,
    private readonly savedDestinations: SavedDestinationsService,
  ) {}

  async sendByUsername(userId: string, input: { username: string; asset: string; amount: string; password?: string }) {
    await this.flags.assertWithdrawalsAllowed();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, kycTier: true, createdAt: true, credentialsChangedAt: true },
    });
    if (!user) throw new NotFoundException('User not found');
    await this.policy.assertCooledOff(user, PolicyAction.CRYPTO_WITHDRAW);

    const amount = positiveAmount(input.amount);
    const asset = await this.assets.require(String(input.asset ?? '').toLowerCase());
    if (asset.isFiat) throw new BadRequestException('Only crypto can be sent by username.');

    const to = await this.usernames.find(input.username);
    await this.peers.assertCanReceive(userId, to.id);

    if (await this.needsPassword(userId, to.id, asset.code, amount)) {
      if (!input.password) {
        throw new ForbiddenException({
          code: 'PASSWORD_REQUIRED',
          message: `Enter your password to send this much to ${displayName(to)} for the first time.`,
        });
      }
      await this.savedDestinations.confirmPassword(userId, input.password);
    }

    const sent = await this.peers.send({ senderId: userId, recipientId: to.id, asset, amount, level: levelOf(user.kycTier) });
    return { ...sent, to: { username: to.payUsername, displayName: displayName(to) } };
  }

  /**
   * A first send to this person worth ₦100,000 or more: someone holding a
   * stolen session should not be able to empty a wallet to a new name. When
   * the size cannot be judged (no price), the password is asked for.
   */
  private async needsPassword(senderId: string, receiverId: string, code: string, amount: ReturnType<typeof dec>): Promise<boolean> {
    const sentBefore = await this.prisma.transaction.findFirst({
      where: { userId: senderId, peerUserId: receiverId, type: TxType.WITHDRAWAL, status: TxStatus.COMPLETED },
      select: { id: true },
    });
    if (sentBefore) return false;
    try {
      const [price, fx] = await Promise.all([this.rates.price(code), this.policy.fx()]);
      return amount.mul(price.priceUsd).mul(fx.ngnPerUsd).gte(FIRST_SEND_PASSWORD_NGN);
    } catch {
      return true;
    }
  }
}
