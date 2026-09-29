import { Injectable, Logger } from '@nestjs/common';
import { LedgerAccount, LegState, SettlementLegKind, TxStatus, TxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuidaxClient } from '../quidax/quidax.client';
import { QuidaxError, QuidaxUnknownError } from '../quidax/quidax.errors';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReferralsService } from '../referrals/referrals.service';
import { ProvisioningService } from '../users/provisioning.service';
import { Decimal, dec, str } from '../common/money';
import type { QuidaxSwapTransaction, QuidaxWithdrawal } from '../quidax/quidax.types';

export type SettlementSource = 'INVENTORY' | 'FALLBACK_SWAP';

/**
 * Moves coin between the main wallet and a user's sub-account, and records
 * every upstream call as a leg so a stuck one can be found.
 *
 * The distinction that matters throughout: a definite failure can be
 * compensated; an UNKNOWN outcome cannot. A timeout leaves funds locked and
 * hands the transaction to the reconciler — never a blind retry, never a refund.
 */
@Injectable()
export class SettlementService {
  private readonly log = new Logger(SettlementService.name);
  private mainAccountId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly quidax: QuidaxClient,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
    private readonly provisioning: ProvisioningService,
    private readonly referrals: ReferralsService,
  ) {}

  async mainAccount(): Promise<string> {
    if (this.mainAccountId) return this.mainAccountId;
    const me = await this.quidax.fetchMainAccount();
    this.mainAccountId = me.id ?? me.sn;
    return this.mainAccountId;
  }

  /** Treasury inventory for a coin, read from the main wallet. */
  async inventory(assetCode: string): Promise<Decimal> {
    const wallet = await this.quidax.fetchWallet(assetCode.toLowerCase(), 'me');
    return dec(wallet.balance || '0');
  }

  /**
   * Internal transfer. Free, synchronous, returns status:"done" — this is the
   * settlement primitive the whole platform runs on.
   */
  async transfer(params: {
    transactionId: string;
    fromQuidaxId: string;
    toQuidaxId: string;
    assetCode: string;
    amount: Decimal;
    kind: SettlementLegKind;
  }): Promise<QuidaxWithdrawal> {
    const reference = this.quidax.newReference('xfer');

    const leg = await this.prisma.settlementLeg.create({
      data: {
        transactionId: params.transactionId,
        kind: params.kind,
        assetCode: params.assetCode,
        amount: params.amount.toFixed(),
        reference,
        state: LegState.PENDING,
      },
    });

    try {
      const result = await this.quidax.internalTransfer(params.fromQuidaxId, {
        currency: params.assetCode,
        amount: params.amount.toFixed(),
        fund_uid: params.toQuidaxId,
        reference,
      });

      await this.prisma.settlementLeg.update({
        where: { id: leg.id },
        data: {
          state: result.status?.toLowerCase() === 'done' ? LegState.CONFIRMED : LegState.SENT,
          quidaxRef: result.id,
          attempts: { increment: 1 },
        },
      });
      return result;
    } catch (err) {
      // A timeout on a transfer is NOT a failure. It may well have landed.
      const unknown = err instanceof QuidaxUnknownError;
      await this.prisma.settlementLeg.update({
        where: { id: leg.id },
        data: {
          state: unknown ? LegState.UNKNOWN : LegState.FAILED,
          attempts: { increment: 1 },
          lastError: (err as Error).message.slice(0, 1000),
        },
      });
      throw err;
    }
  }

  /**
   * Buy the shortfall on the main account when inventory cannot cover a trade.
   *
   * This is the floor, not a loss: the quote came from the same instant-swap
   * rate, so the gate survives intact — inventory just earns more on top.
   */
  async fallbackSwap(params: {
    transactionId: string;
    fromCurrency: string;
    toCurrency: string;
    toAmount: Decimal;
  }): Promise<QuidaxSwapTransaction> {
    const reference = this.quidax.newReference('swap');
    const leg = await this.prisma.settlementLeg.create({
      data: {
        transactionId: params.transactionId,
        kind: SettlementLegKind.SWAP,
        assetCode: params.toCurrency,
        amount: params.toAmount.toFixed(),
        reference,
        state: LegState.PENDING,
      },
    });

    try {
      const quotation = await this.quidax.createSwapQuotation('me', {
        from_currency: params.fromCurrency,
        to_currency: params.toCurrency,
        to_amount: params.toAmount.toFixed(),
      });

      // Confirm immediately — the quotation dies at 15 seconds.
      const result = await this.quidax.confirmSwap('me', quotation.id);

      await this.prisma.settlementLeg.update({
        where: { id: leg.id },
        data: { state: LegState.SENT, quidaxRef: result.id, attempts: { increment: 1 } },
      });
      return result;
    } catch (err) {
      const unknown = err instanceof QuidaxUnknownError;
      await this.prisma.settlementLeg.update({
        where: { id: leg.id },
        data: {
          state: unknown ? LegState.UNKNOWN : LegState.FAILED,
          attempts: { increment: 1 },
          lastError: (err as Error).message.slice(0, 1000),
        },
      });
      throw err;
    }
  }

  /** Swap inside the user's own sub-account. Nothing crosses accounts. */
  async swapInSubAccount(params: {
    transactionId: string;
    quidaxUserId: string;
    fromCurrency: string;
    toCurrency: string;
    fromAmount: Decimal;
  }): Promise<QuidaxSwapTransaction> {
    const reference = this.quidax.newReference('subswap');
    const leg = await this.prisma.settlementLeg.create({
      data: {
        transactionId: params.transactionId,
        kind: SettlementLegKind.SWAP,
        assetCode: params.fromCurrency,
        amount: params.fromAmount.toFixed(),
        reference,
        state: LegState.PENDING,
      },
    });

    try {
      const quotation = await this.quidax.createSwapQuotation(params.quidaxUserId, {
        from_currency: params.fromCurrency,
        to_currency: params.toCurrency,
        from_amount: params.fromAmount.toFixed(),
      });
      const result = await this.quidax.confirmSwap(params.quidaxUserId, quotation.id);

      await this.prisma.settlementLeg.update({
        where: { id: leg.id },
        data: { state: LegState.SENT, quidaxRef: result.id, attempts: { increment: 1 } },
      });
      return result;
    } catch (err) {
      const unknown = err instanceof QuidaxUnknownError;
      await this.prisma.settlementLeg.update({
        where: { id: leg.id },
        data: {
          state: unknown ? LegState.UNKNOWN : LegState.FAILED,
          attempts: { increment: 1 },
          lastError: (err as Error).message.slice(0, 1000),
        },
      });
      throw err;
    }
  }

  // ── webhook reconciliation ──────────────────────────────────

  /**
   * Withdrawal outcomes. These CONFIRM what a synchronous transfer already
   * told us; they are not the trigger. The exception is a rejection, which is
   * the only thing that turns a pending user withdrawal into a refund.
   */
  async applyWithdrawalWebhook(event: string, data: QuidaxWithdrawal): Promise<void> {
    if (!data.reference) return;

    const leg = await this.prisma.settlementLeg.findUnique({
      where: { reference: data.reference },
      include: { transaction: true },
    });

    if (leg) {
      await this.prisma.settlementLeg.update({
        where: { id: leg.id },
        data: {
          state: event === 'withdraw.successful' ? LegState.CONFIRMED : LegState.FAILED,
          quidaxRef: data.id,
        },
      });
    }

    const tx = await this.prisma.transaction.findFirst({
      where: { reference: data.reference },
    });
    if (!tx || tx.type !== TxType.WITHDRAWAL) return;
    if (tx.status === TxStatus.COMPLETED || tx.status === TxStatus.FAILED) return;

    if (event === 'withdraw.successful') {
      await this.prisma.serializable(async (t) => {
        await this.ledger.settleLocked(t, {
          userId: tx.userId,
          assetCode: tx.fromAsset!,
          amount: dec(tx.fromAmount!),
          counterparty: LedgerAccount.EXTERNAL,
          transactionId: tx.id,
          memo: `withdrawal ${data.txid ?? data.id}`,
        });
        await t.transaction.update({
          where: { id: tx.id },
          data: {
            status: TxStatus.COMPLETED,
            completedAt: new Date(),
            quidaxRawStatus: data.status,
            quidaxRef: data.id,
          },
        });
      });

      await this.notifications.notify({
        userId: tx.userId,
        transactionId: tx.id,
        type: 'withdrawal.sent',
        title: `${str(dec(tx.fromAmount!), 8)} ${tx.fromAsset!.toUpperCase()} sent`,
        body: data.txid ? `Transaction hash: ${data.txid}` : 'Your withdrawal has been sent.',
        email: {
          key: 'withdrawal.sent',
          variables: {
            amount: str(dec(tx.fromAmount!), 8),
            assetCode: tx.fromAsset!.toUpperCase(),
            // The destination address is neither stored on the transaction nor
            // returned by the webhook. The hash is, and it is the more useful
            // of the two anyway — it is what a block explorer takes.
            txHash: data.txid ?? 'not yet available',
            transactionId: tx.id,
          },
        },
      });
    } else {
      // Rejected — release the lock. The money never left, so this is a clean
      // unlock rather than a compensating credit.
      await this.prisma.serializable(async (t) => {
        await this.ledger.unlock(t, tx.userId, tx.fromAsset!, dec(tx.fromAmount!));
        await t.transaction.update({
          where: { id: tx.id },
          data: {
            status: TxStatus.FAILED,
            failureReason: data.reason ?? 'Rejected by provider',
            quidaxRawStatus: data.status,
          },
        });
      });

      await this.notifications.notify({
        userId: tx.userId,
        transactionId: tx.id,
        type: 'withdrawal.rejected',
        title: 'Withdrawal could not be completed',
        body: `Your ${tx.fromAsset!.toUpperCase()} has been returned to your balance.`,
        email: {
          key: 'withdrawal.rejected',
          variables: {
            amount: str(dec(tx.fromAmount!), 8),
            assetCode: tx.fromAsset!.toUpperCase(),
            reason: data.reason ?? 'Rejected by provider',
            transactionId: tx.id,
          },
        },
      });
    }
  }

  /**
   * Swap outcomes. confirmSwap returns "initiated", so completion arrives here
   * — or from the poller, whichever wins.
   */
  async applySwapWebhook(event: string, data: QuidaxSwapTransaction): Promise<void> {
    const leg = await this.prisma.settlementLeg.findFirst({
      where: { quidaxRef: data.id },
      include: { transaction: true },
    });
    if (!leg) return;

    const failed = event === 'swap_transaction.failed';
    await this.prisma.settlementLeg.update({
      where: { id: leg.id },
      data: { state: failed ? LegState.FAILED : LegState.CONFIRMED },
    });

    const tx = leg.transaction;
    if (tx.status === TxStatus.COMPLETED || tx.status === TxStatus.FAILED) return;

    if (failed) {
      await this.reverse(tx.id, 'The swap could not be completed');
      return;
    }

    // Settled upstream. Credit what the quote promised, not what came back —
    // the small variance is the treasury's, which is what the spread pays for.
    await this.finaliseSwap(tx.id);
  }

  async finaliseSwap(transactionId: string): Promise<void> {
    const tx = await this.prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    if (tx.status === TxStatus.COMPLETED) return;

    await this.prisma.serializable(async (t) => {
      await this.ledger.settleLocked(t, {
        userId: tx.userId,
        assetCode: tx.fromAsset!,
        amount: dec(tx.fromAmount!),
        counterparty: LedgerAccount.INVENTORY,
        transactionId: tx.id,
        memo: 'swap in',
      });
      await this.ledger.credit(t, {
        userId: tx.userId,
        assetCode: tx.toAsset!,
        amount: dec(tx.toAmount!),
        counterparty: LedgerAccount.INVENTORY,
        transactionId: tx.id,
        memo: 'swap out',
      });
      await t.transaction.update({
        where: { id: tx.id },
        data: { status: TxStatus.COMPLETED, completedAt: new Date() },
      });
    });

    await this.notifications.notify({
      userId: tx.userId,
      transactionId: tx.id,
      type: 'trade.completed',
      title: 'Swap complete',
      body: `${str(dec(tx.fromAmount!), 8)} ${tx.fromAsset!.toUpperCase()} → ${str(dec(tx.toAmount!), 8)} ${tx.toAsset!.toUpperCase()}`,
      email: {
        key: 'trade.swap.completed',
        variables: {
          fromAmount: str(dec(tx.fromAmount!), 8),
          fromAsset: tx.fromAsset!.toUpperCase(),
          toAmount: str(dec(tx.toAmount!), 8),
          toAsset: tx.toAsset!.toUpperCase(),
          transactionId: tx.id,
        },
      },
    });

    // A completed trade can be the last thing standing between somebody and
    // their referral bonus. Never throws — see ReferralsService.evaluate.
    await this.referrals.evaluate(tx.userId);
  }

  /**
   * Compensate a failed trade: release the lock, mark FAILED, tell the user
   * plainly that nothing was taken.
   *
   * Only ever called for a DEFINITE failure. An unknown outcome goes to
   * RECONCILING instead — refunding an unknown is how a user ends up with both
   * the coin and their money back.
   */
  async reverse(transactionId: string, reason: string): Promise<void> {
    const tx = await this.prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    if (tx.status === TxStatus.FAILED || tx.status === TxStatus.COMPLETED) return;

    await this.prisma.serializable(async (t) => {
      if (tx.fromAsset && tx.fromAmount) {
        await this.ledger.unlock(t, tx.userId, tx.fromAsset, dec(tx.fromAmount));
      }
      await t.transaction.update({
        where: { id: tx.id },
        data: { status: TxStatus.FAILED, failureReason: reason },
      });
    });

    await this.notifications.notify({
      userId: tx.userId,
      transactionId: tx.id,
      type: 'trade.failed',
      title: 'Trade could not be completed',
      body: `${reason}. Nothing was deducted from your balance.`,
      email: {
        key: 'trade.failed',
        variables: { reason, transactionId: tx.id },
      },
    });

    this.log.warn(`Reversed ${tx.id}: ${reason}`);
  }

  /** Park a transaction whose outcome is genuinely unknown. Funds stay locked. */
  async markReconciling(transactionId: string, reason: string): Promise<void> {
    await this.prisma.transaction.update({
      where: { id: transactionId },
      data: { status: TxStatus.RECONCILING, failureReason: reason },
    });
    this.log.error(`RECONCILING ${transactionId}: ${reason} — funds remain locked`);
  }

  async quidaxIdFor(userId: string): Promise<string> {
    return this.provisioning.requireQuidaxId(userId);
  }

  /** Convert an upstream error into the right terminal state. */
  isUnknown(err: unknown): boolean {
    return err instanceof QuidaxUnknownError;
  }

  describe(err: unknown): string {
    if (err instanceof QuidaxError) return err.message;
    if (err instanceof QuidaxUnknownError) return 'Outcome unknown — awaiting confirmation';
    return (err as Error)?.message ?? 'Unexpected error';
  }
}
