import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { type Asset, PolicyAction, PolicyLevel, SettlementLegKind, TxStatus, TxType, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuidaxClient } from '../quidax/quidax.client';
import { LedgerService } from '../ledger/ledger.service';
import { AssetsService } from '../assets/assets.service';
import { RatesService } from '../rates/rates.service';
import { LevelPolicyService } from '../levels/level-policy.service';
import { SettlementService } from '../trades/settlement.service';
import { levelOf } from '../levels/levels';
import { ZERO, str, type Decimal } from '../common/money';

/**
 * Coins sent to an address that belongs to another DavoChain customer
 * (28 Oct 2026).
 *
 * Every customer's deposit address is on their own Quidax sub-account. Quidax
 * moves coins between two of its accounts without the blockchain and reports
 * the arrival as an "internal" deposit, which DepositsService ignores on
 * purpose (H12: those are normally our own settlement transfers). Sent the
 * usual way, the sender was charged and the receiver was never credited.
 *
 * So such a send never goes the usual way: it is an internal transfer between
 * the two sub-accounts, free, and the receiver is credited by
 * SettlementService.completePeerSend, never by the deposit webhook.
 */
@Injectable()
export class PeerSendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quidax: QuidaxClient,
    private readonly ledger: LedgerService,
    private readonly assets: AssetsService,
    private readonly rates: RatesService,
    private readonly policy: LevelPolicyService,
    private readonly settlement: SettlementService,
  ) {}

  /**
   * The DavoChain customer this address belongs to, or null for an outside
   * wallet. Refuses the sender's own address and a receiver who cannot receive
   * (decisions 28 Oct 2026: Basic verification is needed to receive).
   */
  async recipientFor(senderId: string, address: string, destinationTag?: string): Promise<string | null> {
    const rows = await this.prisma.depositAddress.findMany({
      // Some chains' addresses are not case-sensitive (0xAbC… is 0xabc…).
      where: { address: { equals: address.trim(), mode: 'insensitive' } },
      select: { userId: true, destinationTag: true },
      take: 50,
    });
    // A shared address (XRP, XLM…) tells customers apart by the tag alone.
    const tag = destinationTag?.trim() || null;
    const match = rows.find((r) => !r.destinationTag || r.destinationTag === tag);
    if (!match) return null;
    await this.assertCanReceive(senderId, match.userId);
    return match.userId;
  }

  /**
   * Whether this customer may receive from this sender: never yourself, and
   * only an open account that finished Basic verification (decision 28 Oct 2026).
   */
  async assertCanReceive(senderId: string, receiverId: string): Promise<void> {
    if (receiverId === senderId) {
      throw new BadRequestException({ code: 'OWN_ADDRESS', message: 'You cannot send to your own DavoChain account.' });
    }
    const receiver = await this.prisma.user.findUnique({ where: { id: receiverId }, select: { status: true, kycTier: true } });
    if (!receiver || receiver.status !== UserStatus.ACTIVE) {
      throw new BadRequestException({
        code: 'RECIPIENT_CANNOT_RECEIVE',
        message: 'This DavoChain account cannot receive coins right now.',
      });
    }
    if (levelOf(receiver.kycTier) === PolicyLevel.NONE) {
      throw new BadRequestException({
        code: 'RECIPIENT_NOT_VERIFIED',
        message: 'This DavoChain customer has not finished Basic verification, so they cannot receive coins yet. Ask them to verify first.',
      });
    }
  }

  async send(input: {
    senderId: string;
    recipientId: string;
    asset: Asset;
    amount: Decimal;
    level: PolicyLevel;
    savedCryptoAddressId?: string;
  }) {
    const { senderId, recipientId, asset, amount, level } = input;
    const code = asset.code;
    // Quidax's own limits for a transfer between two of its accounts.
    this.assets.assertTransferable(asset, amount);

    // The sender's withdrawal limits still apply: free is not unlimited.
    const price = await this.rates.price(code).catch(() => null);
    const usdValue = price ? amount.mul(price.priceUsd) : null;
    if (!usdValue) {
      const rule = (await this.policy.rulesFor(level)).find((r) => r.action === PolicyAction.CRYPTO_WITHDRAW);
      if (rule && (rule.minPerTx != null || rule.maxPerTx != null || rule.maxPerDay != null)) {
        throw new ServiceUnavailableException('Pricing is unavailable right now. Please try again shortly.');
      }
    }
    const fx = await this.policy.fx();
    const [fromId, toId] = await Promise.all([this.settlement.quidaxIdFor(senderId), this.settlement.quidaxIdFor(recipientId)]);
    const reference = this.quidax.newReference('peer');

    const tx = await this.prisma.serializable(async (t) => {
      await this.policy.assertWithinLimits(t, senderId, level, PolicyAction.CRYPTO_WITHDRAW, usdValue ?? ZERO, 'USD', fx);
      await this.ledger.lock(t, senderId, code, amount);
      const created = await t.transaction.create({
        data: {
          userId: senderId,
          type: TxType.WITHDRAWAL,
          status: TxStatus.PENDING,
          fromAsset: code,
          fromAmount: amount.toFixed(),
          toAsset: code,
          toAmount: amount.toFixed(),
          // DavoChain to DavoChain is free (decision 28 Oct 2026), and no chain is involved.
          feeAmount: '0',
          feeAsset: code,
          feeUsd: '0',
          networkFee: '0',
          usdValue: usdValue?.toFixed() ?? null,
          savedCryptoAddressId: input.savedCryptoAddressId,
          peerUserId: recipientId,
          reference,
        },
      });
      await t.settlementLeg.create({
        data: { transactionId: created.id, kind: SettlementLegKind.PEER_TRANSFER, assetCode: code, amount: amount.toFixed(), reference },
      });
      return created;
    });

    const answer = (status: TxStatus) => ({
      transactionId: tx.id,
      status,
      asset: code,
      amount: str(amount, asset.displayScale),
      toDavoChainCustomer: true,
    });

    let result: Awaited<ReturnType<QuidaxClient['internalTransfer']>>;
    try {
      result = await this.quidax.internalTransfer(fromId, { currency: code, amount: amount.toFixed(), fund_uid: toId, reference });
    } catch (err) {
      const unknown = this.settlement.isUnknown(err);
      await this.prisma.settlementLeg.update({
        where: { reference },
        data: { state: unknown ? 'UNKNOWN' : 'FAILED', attempts: { increment: 1 }, lastError: this.settlement.internalReason(err).slice(0, 1000) },
      });
      if (unknown) {
        // It may have moved: never refund an unknown. The reconciler finishes it.
        await this.settlement.markReconciling(tx.id, this.settlement.describe(err), this.settlement.internalReason(err));
        return answer(TxStatus.RECONCILING);
      }
      await this.settlement.reverse(tx.id, this.settlement.describe(err));
      throw new BadRequestException(`${this.settlement.describe(err)}. Nothing was deducted from your balance.`);
    }

    try {
      await this.prisma.settlementLeg.update({
        where: { reference },
        data: { state: result.status?.toLowerCase() === 'done' ? 'CONFIRMED' : 'SENT', quidaxRef: result.id, attempts: { increment: 1 } },
      });
      if (result.status?.toLowerCase() !== 'done') {
        await this.prisma.transaction.update({ where: { id: tx.id }, data: { status: TxStatus.PROCESSING, quidaxRef: result.id, quidaxRawStatus: result.status } });
        return answer(TxStatus.PROCESSING);
      }
      await this.settlement.completePeerSend(tx.id, result.id);
      return answer(TxStatus.COMPLETED);
    } catch (err) {
      // C3: Quidax moved the coins. A failure on our side is never a refund.
      await this.settlement.markReconciling(tx.id, 'Being checked — awaiting confirmation', `Peer transfer accepted but local update failed: ${(err as Error).message}`);
      return answer(TxStatus.RECONCILING);
    }
  }
}
