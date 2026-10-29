import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PolicyAction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AssetsService } from '../assets/assets.service';
import { LevelPolicyService } from '../levels/level-policy.service';
import { SystemFlagsService } from '../common/system-flags.service';
import { PeerSendService } from '../withdrawals/peer-send.service';
import { positiveAmount } from '../withdrawals/withdrawals.service';
import { levelOf } from '../levels/levels';
import { PayUsernamesService } from './pay-usernames.service';
import { displayName } from './pay-username';

/**
 * Send crypto to a DavoChain customer by payment username (28 Oct 2026).
 * The money moves through PeerSendService, the same engine as a send to a
 * DavoChain address: free, instant, credited once, the sender's withdrawal
 * limits applied.
 *
 * The transaction PIN (29 Oct 2026) is checked on the route before this runs.
 * It replaced the password asked for on a first send of ₦100,000 or more.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assets: AssetsService,
    private readonly policy: LevelPolicyService,
    private readonly flags: SystemFlagsService,
    private readonly usernames: PayUsernamesService,
    private readonly peers: PeerSendService,
  ) {}

  async sendByUsername(userId: string, input: { username: string; asset: string; amount: string }) {
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

    const sent = await this.peers.send({ senderId: userId, recipientId: to.id, asset, amount, level: levelOf(user.kycTier) });
    return { ...sent, to: { username: to.payUsername, displayName: displayName(to) } };
  }
}
