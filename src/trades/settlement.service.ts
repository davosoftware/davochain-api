import { Injectable, Logger, Optional } from '@nestjs/common';
import { AlertType, LedgerAccount, LegState, SettlementLegKind, TxStatus, TxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuidaxClient } from '../quidax/quidax.client';
import { QuidaxError, QuidaxRateLimitError, QuidaxUnknownError } from '../quidax/quidax.errors';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReferralsService } from '../referrals/referrals.service';
import { ProvisioningService } from '../users/provisioning.service';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { Decimal, dec, str } from '../common/money';
import type { QuidaxSwapQuotation, QuidaxSwapTransaction, QuidaxWithdrawal } from '../quidax/quidax.types';
import { closeOpen, OPEN_STATUSES } from './close-open';

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
    /** Tells a person when a swap delivered a different amount than quoted. */
    @Optional() private readonly alerts?: OpsAlertsService,
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
      const unknown = this.isUnknown(err);
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
      const unknown = this.isUnknown(err);
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
   * Wait for a main-account swap to land before anything relies on its coin
   * (H3). confirmSwap only says "initiated"; moving the coin before the swap
   * completes fails, or worse, takes inventory the swap never replaced.
   *
   * completed -> leg CONFIRMED, return.
   * failed    -> leg FAILED, a definite failure (nothing happened: safe to refund).
   * otherwise, after the wait -> unknown: no refund, nothing moved; the trade
   *              goes to RECONCILING with the swap leg still SENT.
   */
  async awaitSwap(swapId: string, owner = 'me', attempts = 10, intervalMs = 1500): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      const swaps = await this.quidax.fetchSwapTransactions(owner).catch((): QuidaxSwapTransaction[] => []);
      const status = swaps.find((s) => s.id === swapId)?.status?.toLowerCase();
      if (status === 'completed') {
        await this.prisma.settlementLeg.updateMany({
          where: { quidaxRef: swapId, kind: SettlementLegKind.SWAP },
          data: { state: LegState.CONFIRMED },
        });
        return;
      }
      if (status === 'failed') {
        await this.prisma.settlementLeg.updateMany({
          where: { quidaxRef: swapId, kind: SettlementLegKind.SWAP },
          data: { state: LegState.FAILED, lastError: 'Swap failed upstream' },
        });
        throw new QuidaxError('The swap could not be completed', null, 422);
      }
      if (i < attempts - 1) await this.pause(intervalMs);
    }
    throw new QuidaxUnknownError(`Swap ${swapId} not completed after waiting`, 'GET', `/users/${owner}/swap_transactions`);
  }

  /** A seam for tests: the real wait. */
  protected pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Quidax's live swap price for this customer, in their own sub-account
   * (27 Oct 2026). A quote is priced from it and the swap confirms the same
   * quotation, so what the customer is shown is what Quidax delivers. Asking
   * for a quotation moves nothing; an unused one just expires (~15 s).
   */
  async swapQuotation(quidaxUserId: string, fromCurrency: string, toCurrency: string, fromAmount: Decimal): Promise<QuidaxSwapQuotation> {
    return this.quidax.createSwapQuotation(quidaxUserId, {
      from_currency: fromCurrency,
      to_currency: toCurrency,
      from_amount: fromAmount.toFixed(),
    });
  }

  /**
   * Swap inside the user's own sub-account. Nothing crosses accounts.
   * With `quotationId`, confirms the quotation the customer was quoted from;
   * without one (older quotes), asks Quidax for a new quotation first.
   */
  async swapInSubAccount(params: {
    transactionId: string;
    quidaxUserId: string;
    fromCurrency: string;
    toCurrency: string;
    fromAmount: Decimal;
    quotationId?: string | null;
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
      const quotationId =
        params.quotationId ?? (await this.swapQuotation(params.quidaxUserId, params.fromCurrency, params.toCurrency, params.fromAmount)).id;
      const result = await this.quidax.confirmSwap(params.quidaxUserId, quotationId);

      await this.prisma.settlementLeg.update({
        where: { id: leg.id },
        data: { state: LegState.SENT, quidaxRef: result.id, attempts: { increment: 1 } },
      });
      return result;
    } catch (err) {
      const unknown = this.isUnknown(err);
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
    const tx = await this.prisma.transaction.findFirst({
      where: { reference: data.reference },
    });
    if (!tx || tx.type !== TxType.WITHDRAWAL) return;
    if (tx.status === TxStatus.COMPLETED || tx.status === TxStatus.FAILED) return;

    const leg = await this.prisma.settlementLeg.findUnique({
      where: { reference: data.reference },
    });
    const isNgn = tx.fromAsset === 'ngn';
    const lockedAmount = dec(tx.fromAmount!);
    const payoutAmount = tx.toAmount
      ? dec(tx.toAmount)
      : lockedAmount.minus(dec(tx.feeAmount ?? 0)).minus(dec(tx.networkFee ?? 0));

    if (event === 'withdraw.successful') {
      // Quidax documents the successful event as authoritative for fiat; its
      // payload may still say status="Processing". Include stamp duty when
      // balancing the provider's actual debit against our locked amount.
      const providerFee = dec(data.fee ?? tx.networkFee ?? 0).plus(data.stamp_duty_fee ?? 0);
      const externalAmount = payoutAmount.plus(providerFee);
      const netPlatform = lockedAmount.minus(externalAmount);
      const entries: {
        account: LedgerAccount;
        assetCode: string;
        direction: 'CREDIT' | 'DEBIT';
        amount: Decimal;
        memo: string;
      }[] = [
        {
          account: LedgerAccount.EXTERNAL,
          assetCode: tx.fromAsset!,
          direction: 'CREDIT',
          amount: externalAmount,
          memo: `withdrawal ${data.txid ?? data.id}`,
        },
      ];
      if (!netPlatform.isZero()) {
        entries.push({
          account: LedgerAccount.REVENUE,
          assetCode: tx.fromAsset!,
          direction: netPlatform.gt(0) ? 'CREDIT' : 'DEBIT',
          amount: netPlatform.abs(),
          memo: `withdrawal platform margin ${tx.id}`,
        });
      }

      // H6: close first, conditionally; only the caller that closes it settles.
      const won = await this.prisma.serializable(async (t) => {
        const closed = await closeOpen(t, tx.id, {
          status: TxStatus.COMPLETED,
          completedAt: new Date(),
          quidaxRawStatus: data.status,
          quidaxRef: data.id,
          networkFee: providerFee.toFixed(),
        });
        if (!closed) return false;
        await this.ledger.settleLockedWithEntries(t, {
          userId: tx.userId,
          assetCode: tx.fromAsset!,
          amount: lockedAmount,
          transactionId: tx.id,
          entries,
        });
        if (leg) {
          await t.settlementLeg.update({
            where: { id: leg.id },
            data: { state: LegState.CONFIRMED, quidaxRef: data.id },
          });
        }
        // H4: a crypto withdrawal's platform fee never leaves the user's
        // sub-account. Record it as owed to us, like a swap fee, so the custody
        // check balances and a fee claim can collect it. (A naira payout's fee
        // stays in the main account, so it needs nothing.)
        if (!isNgn && netPlatform.gt(0)) {
          await t.feeReceivable.create({
            data: {
              userId: tx.userId,
              assetCode: tx.fromAsset!,
              amount: netPlatform.toFixed(),
              usdAtAccrual: tx.feeUsd ?? '0',
            },
          });
        }
        return true;
      });
      if (!won) return;

      const amountText = str(payoutAmount, isNgn ? 2 : 8);
      await this.notifications.notify({
        userId: tx.userId,
        transactionId: tx.id,
        type: 'withdrawal.sent',
        title: isNgn ? `₦${amountText} sent` : `${amountText} ${tx.fromAsset!.toUpperCase()} sent`,
        body: isNgn
          ? `Sent to ${tx.payoutBankName ?? 'your bank'} account ending ${tx.payoutAccountLast4 ?? '****'}.`
          : data.txid
            ? `Transaction hash: ${data.txid}`
            : 'Your withdrawal has been sent.',
        email: {
          key: isNgn ? 'ngn.withdrawal.sent' : 'withdrawal.sent',
          variables: isNgn
            ? {
                amount: amountText,
                fee: str(tx.feeAmount ?? 0, 2),
                bankName: tx.payoutBankName ?? 'your bank',
                accountNumber: `****${tx.payoutAccountLast4 ?? ''}`,
                transactionId: tx.id,
              }
            : {
                amount: amountText,
                assetCode: tx.fromAsset!.toUpperCase(),
                txHash: data.txid ?? 'not yet available',
                transactionId: tx.id,
              },
        },
      });
    } else {
      // Rejected — release the lock. The money never left, so this is a clean
      // unlock rather than a compensating credit.
      const won = await this.prisma.serializable(async (t) => {
        const closed = await closeOpen(t, tx.id, {
          status: TxStatus.FAILED,
          failureReason: data.reason ?? 'Rejected by provider',
          quidaxRawStatus: data.status,
        });
        if (!closed) return false;
        await this.ledger.unlock(t, tx.userId, tx.fromAsset!, lockedAmount);
        if (leg) {
          await t.settlementLeg.update({
            where: { id: leg.id },
            data: { state: LegState.FAILED, quidaxRef: data.id, lastError: data.reason ?? null },
          });
        }
        return true;
      });
      if (!won) return;

      await this.notifications.notify({
        userId: tx.userId,
        transactionId: tx.id,
        type: 'withdrawal.rejected',
        title: 'Withdrawal could not be completed',
        body: `Your ${tx.fromAsset!.toUpperCase()} withdrawal was returned to your balance.`,
        email: {
          key: isNgn ? 'ngn.withdrawal.rejected' : 'withdrawal.rejected',
          variables: isNgn
            ? {
                amount: str(payoutAmount, 2),
                bankName: tx.payoutBankName ?? 'your bank',
                accountNumber: `****${tx.payoutAccountLast4 ?? ''}`,
                reason: data.reason ?? 'Rejected by provider',
                transactionId: tx.id,
              }
            : {
                amount: str(payoutAmount, 8),
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

    // Settled upstream: credit what Quidax delivered into the customer's
    // sub-account, minus our fee (27 Oct 2026), so the books match custody.
    await this.finaliseSwap(tx.id, data.received_amount);
  }

  /**
   * Completes a coin-to-coin swap. `receivedAmount` is what Quidax delivered
   * into the customer's sub-account (from its own confirmed record). The
   * customer is credited that minus our fee, so their DavoChain balance always
   * equals what Quidax holds for them (the custody check). Swaps are priced
   * from Quidax's own quotation, so this normally equals the quote; if it
   * doesn't, the delivered amount wins and a person is told. Unknown (an
   * owner resolving by hand, or an unreadable amount): the quoted amount.
   */
  async finaliseSwap(transactionId: string, receivedAmount?: string | null): Promise<void> {
    const tx = await this.prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    if (tx.status === TxStatus.COMPLETED) return;

    const quoted = dec(tx.toAmount!);
    const fee = dec(tx.feeAmount ?? 0);
    let received: Decimal | null = null;
    try {
      received = receivedAmount != null && receivedAmount !== '' ? dec(receivedAmount) : null;
    } catch {
      received = null;
    }
    const credited = received && received.isFinite() && received.gt(0) ? Decimal.max(received.minus(fee), 0) : quoted;
    const differs = !credited.eq(quoted);
    // The quote is rounded down to the coin's smallest unit and Quidax delivers
    // the exact amount, so a sliver above the quote is normal and not worth a
    // person's time. Less than quoted, or more than 0.01% above, is.
    const unexpected = credited.lt(quoted) || credited.minus(quoted).gt(quoted.mul('0.0001'));

    const won = await this.prisma.serializable(async (t) => {
      if (!(await closeOpen(t, tx.id, { status: TxStatus.COMPLETED, completedAt: new Date(), ...(differs ? { toAmount: credited.toFixed() } : {}) }))) {
        return false;
      }
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
        amount: credited,
        counterparty: LedgerAccount.INVENTORY,
        transactionId: tx.id,
        memo: 'swap out',
      });

      // H2: the fee is earned only by a swap that completed, so it is booked
      // here, in the write that completes it. Booked as a receivable, never
      // collected now: it may be below the coin's transfer minimum; an admin
      // claim sweeps it.
      const fee = dec(tx.feeAmount ?? 0);
      if (tx.feeAsset && fee.gt(0) && tx.rateConfigId) {
        const price = await t.rateSnapshot.findFirst({
          where: { assetCode: tx.feeAsset },
          orderBy: { capturedAt: 'desc' },
        });
        const usdAtAccrual = price ? fee.mul(dec(price.priceUsd)).toFixed() : '0';
        await t.swapFee.create({
          data: { transactionId: tx.id, assetCode: tx.feeAsset, amount: fee.toFixed(), usdAtAccrual, rateConfigId: tx.rateConfigId },
        });
        await t.feeReceivable.create({
          data: { userId: tx.userId, assetCode: tx.feeAsset, amount: fee.toFixed(), usdAtAccrual },
        });
      }
      return true;
    });
    if (!won) return;

    if (unexpected) {
      const coin = tx.toAsset!.toUpperCase();
      this.log.warn(`Swap ${tx.id}: quoted ${quoted.toFixed()} ${coin}, Quidax delivered ${received?.toFixed()} (fee ${fee.toFixed()}); credited ${credited.toFixed()}`);
      await this.alerts
        ?.raise(AlertType.RECONCILIATION_DRIFT, `swap-amount:${tx.id}`, `A swap delivered a different amount than quoted (${coin})`, [
          `Transaction: ${tx.id}`,
          `Quoted to the customer: ${quoted.toFixed()} ${coin}`,
          `Quidax delivered: ${received?.toFixed()} ${coin}; our fee ${fee.toFixed()} ${coin}`,
          `Credited (what arrived minus our fee): ${credited.toFixed()} ${coin}`,
          'Swaps are priced from Quidax\'s own quotation, so this should be rare. If it keeps happening, check the swap settings.',
        ], 0)
        .catch(() => false);
    }

    await this.notifications.notify({
      userId: tx.userId,
      transactionId: tx.id,
      type: 'trade.completed',
      title: 'Swap complete',
      body: `${str(dec(tx.fromAmount!), 8)} ${tx.fromAsset!.toUpperCase()} → ${str(credited, 8)} ${tx.toAsset!.toUpperCase()}`,
      email: {
        key: 'trade.swap.completed',
        variables: {
          fromAmount: str(dec(tx.fromAmount!), 8),
          fromAsset: tx.fromAsset!.toUpperCase(),
          toAmount: str(credited, 8),
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
   * H4: finish a buy or sell whose legs were all confirmed upstream after the
   * request itself gave up (RECONCILING). The same ledger moves as the request
   * path's settle; closed only from an open state, so it runs once.
   */
  async completeTrade(transactionId: string): Promise<boolean> {
    const tx = await this.prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    if (tx.type !== TxType.BUY && tx.type !== TxType.SELL) return false;

    const won = await this.prisma.serializable(async (t) => {
      if (!(await closeOpen(t, tx.id, { status: TxStatus.COMPLETED, completedAt: new Date(), failureReason: null }))) {
        return false;
      }
      await this.ledger.settleLocked(t, {
        userId: tx.userId,
        assetCode: tx.fromAsset!,
        amount: dec(tx.fromAmount!),
        counterparty: LedgerAccount.INVENTORY,
        transactionId: tx.id,
        memo: 'trade in (reconciled)',
      });
      await this.ledger.credit(t, {
        userId: tx.userId,
        assetCode: tx.toAsset!,
        amount: dec(tx.toAmount!),
        counterparty: LedgerAccount.INVENTORY,
        transactionId: tx.id,
        memo: 'trade out (reconciled)',
      });
      return true;
    });
    if (!won) return false;

    await this.notifications.notify({
      userId: tx.userId,
      transactionId: tx.id,
      type: 'trade.completed',
      title: 'Trade complete',
      body: `${str(dec(tx.fromAmount!), 8)} ${tx.fromAsset!.toUpperCase()} → ${str(dec(tx.toAmount!), 8)} ${tx.toAsset!.toUpperCase()}`,
    });
    await this.referrals.evaluate(tx.userId);
    this.log.warn(`Reconciled trade ${tx.id} to COMPLETED`);
    return true;
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

    const won = await this.prisma.serializable(async (t) => {
      if (!(await closeOpen(t, tx.id, { status: TxStatus.FAILED, failureReason: reason }))) return false;
      if (tx.fromAsset && tx.fromAmount) {
        await this.ledger.unlock(t, tx.userId, tx.fromAsset, dec(tx.fromAmount));
      }
      return true;
    });
    if (!won) return;

    const isWithdrawal = tx.type === TxType.WITHDRAWAL;
    const isNgnWithdrawal = isWithdrawal && tx.fromAsset === 'ngn';
    const withdrawalAmount = tx.toAmount
      ? dec(tx.toAmount)
      : dec(tx.fromAmount ?? 0).minus(dec(tx.feeAmount ?? 0)).minus(dec(tx.networkFee ?? 0));

    await this.notifications.notify({
      userId: tx.userId,
      transactionId: tx.id,
      type: isWithdrawal ? 'withdrawal.rejected' : 'trade.failed',
      title: isWithdrawal ? 'Withdrawal could not be completed' : 'Trade could not be completed',
      body: isWithdrawal
        ? `Your ${tx.fromAsset!.toUpperCase()} withdrawal was returned to your balance. ${reason}`
        : `${reason}. Nothing was deducted from your balance.`,
      email: isWithdrawal
        ? {
            key: isNgnWithdrawal ? 'ngn.withdrawal.rejected' : 'withdrawal.rejected',
            variables: isNgnWithdrawal
              ? {
                  amount: str(withdrawalAmount, 2),
                  bankName: tx.payoutBankName ?? 'your bank',
                  accountNumber: `****${tx.payoutAccountLast4 ?? ''}`,
                  reason,
                  transactionId: tx.id,
                }
              : {
                  amount: str(withdrawalAmount, 8),
                  assetCode: tx.fromAsset!.toUpperCase(),
                  reason,
                  transactionId: tx.id,
                },
          }
        : { key: 'trade.failed', variables: { reason, transactionId: tx.id } },
    });

    this.log.warn(`Reversed ${tx.id}: ${reason}`);
  }

  /** Park a transaction whose outcome is genuinely unknown. Funds stay locked. */
  /**
   * `reason` is shown to the customer (M5: use describe()); `detail` is the
   * staff-only cause, written to the log.
   */
  async markReconciling(transactionId: string, reason: string, detail?: string): Promise<void> {
    // Only an open transaction: never re-open one a webhook already finished.
    const { count } = await this.prisma.transaction.updateMany({
      where: { id: transactionId, status: { in: OPEN_STATUSES } },
      data: { status: TxStatus.RECONCILING, failureReason: reason },
    });
    if (count === 0) return;
    this.log.error(`RECONCILING ${transactionId}: ${detail ?? reason} — funds remain locked`);
  }

  async quidaxIdFor(userId: string): Promise<string> {
    return this.provisioning.requireQuidaxId(userId);
  }

  /** Convert an upstream error into the right terminal state. */
  /**
   * C4: an error is a DEFINITE failure only when Quidax plainly refused: a
   * business rejection (4xx, or 200 with status "error") or a rate-limit
   * refusal, where nothing happened. Everything else may have come after a
   * call that worked (an unknown outcome, a gateway page, our own database, a
   * bug), so it is never grounds for a refund: the funds stay locked and the
   * transaction goes to RECONCILING.
   */
  isDefiniteRejection(err: unknown): boolean {
    return err instanceof QuidaxError && err.httpStatus < 500;
  }

  isUnknown(err: unknown): boolean {
    return !this.isDefiniteRejection(err);
  }

  /**
   * The full detail, for staff only: settlement-leg lastError and logs. Never
   * put this where a customer reads it.
   */
  internalReason(err: unknown): string {
    if (err instanceof QuidaxError) {
      return 'Quidax ' + err.httpStatus + (err.code ? ' ' + err.code : '') + ': ' + err.message;
    }
    return (err as Error)?.message ?? String(err);
  }

  /**
   * M5: what a CUSTOMER is told (errors, refund messages, failureReason in their
   * history). A fixed set of plain messages: never Quidax's wording, never our
   * internals, and never whose balance ran short.
   */
  describe(err: unknown): string {
    if (err instanceof QuidaxUnknownError) return 'Outcome unknown — awaiting confirmation';
    if (err instanceof QuidaxRateLimitError) return 'The service is busy. Please try again in a moment';
    if (err instanceof QuidaxError) {
      if (err.isExpiredQuotation || /quotation/i.test(err.message)) {
        return 'The rate changed before we could complete this. Please try again';
      }
      if (err.isBelowMinimum) return 'This amount is below the minimum allowed';
      if (err.isInsufficientBalance) return 'This could not be completed right now. Please try again shortly';
      return 'Our provider could not complete this request';
    }
    return 'Something went wrong on our side';
  }
}
