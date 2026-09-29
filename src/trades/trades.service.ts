import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { LedgerAccount, QuoteSide, SettlementLegKind, TxStatus, TxType } from '@prisma/client';
import { RateQuote } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuidaxClient } from '../quidax/quidax.client';
import { LedgerService } from '../ledger/ledger.service';
import { SettlementService } from './settlement.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReferralsService } from '../referrals/referrals.service';
import { SystemFlagsService } from '../common/system-flags.service';
import { AssetsService } from '../assets/assets.service';
import { InventoryService } from '../inventory/inventory.service';
import { dec, str } from '../common/money';

export interface TradeResult {
  transactionId: string;
  status: TxStatus;
  fromAsset: string;
  fromAmount: string;
  toAsset: string;
  toAmount: string;
  rate: string;
  settledFrom?: string | null;
}

/**
 * Executes a quote.
 *
 * The settlement ladder for a buy:
 *   1. inventory covers it        -> internal transfer main -> sub
 *   2. inventory short            -> instant swap on main, then the transfer
 *   3. nothing left to buy with   -> refuse before debiting
 *   4. accepted then failed       -> refund
 *   -  outcome unknown            -> RECONCILING, funds stay locked, no refund
 */
@Injectable()
export class TradesService {
  private readonly log = new Logger(TradesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly quidax: QuidaxClient,
    private readonly ledger: LedgerService,
    private readonly settlement: SettlementService,
    private readonly notifications: NotificationsService,
    private readonly flags: SystemFlagsService,
    private readonly assets: AssetsService,
    @Inject(forwardRef(() => InventoryService))
    private readonly inventory: InventoryService,
    private readonly referrals: ReferralsService,
  ) {}

  /**
   * Takes an ALREADY-CONSUMED quote. Consuming it is the caller's job, so this
   * service never has to know about quote lifecycle — and the modules stay
   * acyclic.
   */
  async execute(userId: string, quote: RateQuote): Promise<TradeResult> {
    switch (quote.side) {
      case QuoteSide.BUY:
        return this.buy(userId, quote);
      case QuoteSide.SELL:
        return this.sell(userId, quote);
      case QuoteSide.SWAP:
        return this.swap(userId, quote);
    }
  }

  // ── buy ─────────────────────────────────────────────────────

  private async buy(
    userId: string,
    quote: {
      id: string;
      fromAsset: string;
      toAsset: string;
      fromAmount: unknown;
      toAmount: unknown;
      displayedRate: unknown;
      quidaxRate: unknown;
      usdValue: unknown;
      feeUsd: unknown;
      gateApplied: unknown;
      rateConfigId: string;
    },
  ): Promise<TradeResult> {
    await this.flags.assertTradingAllowed(quote.toAsset);

    const ngnIn = dec(quote.fromAmount as string);
    const coinOut = dec(quote.toAmount as string);
    const asset = await this.assets.require(quote.toAsset);

    // Read inventory BEFORE debiting, so a shortfall with no fallback is a
    // refusal rather than an accept-then-reverse.
    const [inventory, mainId, subId] = await Promise.all([
      this.settlement.inventory(quote.toAsset),
      this.settlement.mainAccount(),
      this.settlement.quidaxIdFor(userId),
    ]);

    const inventorySetting = await this.prisma.inventorySetting.findUnique({
      where: { assetCode: quote.toAsset },
    });
    const canFallback = inventorySetting?.fallbackSwapEnabled ?? true;
    const needsFallback = inventory.lt(coinOut);

    if (needsFallback && !canFallback) {
      throw new BadRequestException(
        `${quote.toAsset.toUpperCase()} is temporarily unavailable to buy. Please try again shortly.`,
      );
    }

    // Lock + debit + pending record, all in one transaction, before any call out.
    const tx = await this.prisma.serializable(async (t) => {
      await this.ledger.lock(t, userId, 'ngn', ngnIn);
      return t.transaction.create({
        data: {
          userId,
          type: TxType.BUY,
          status: TxStatus.PENDING,
          fromAsset: 'ngn',
          fromAmount: ngnIn.toFixed(),
          toAsset: quote.toAsset,
          toAmount: coinOut.toFixed(),
          displayedRate: dec(quote.displayedRate as string).toFixed(),
          quidaxRate: dec(quote.quidaxRate as string).toFixed(),
          gateApplied: dec(quote.gateApplied as string).toFixed(),
          usdValue: quote.usdValue ? dec(quote.usdValue as string).toFixed() : null,
          feeUsd: quote.feeUsd ? dec(quote.feeUsd as string).toFixed() : null,
          rateConfigId: quote.rateConfigId,
          reference: this.quidax.newReference('buy'),
          settledFrom: needsFallback ? 'FALLBACK_SWAP' : 'INVENTORY',
        },
      });
    });

    try {
      if (needsFallback) {
        await this.settlement.fallbackSwap({
          transactionId: tx.id,
          fromCurrency: 'ngn',
          toCurrency: quote.toAsset,
          toAmount: coinOut,
        });
      }

      // Chunk if the amount exceeds Quidax's transfer maximum.
      for (const chunk of this.assets.chunkForTransfer(asset, coinOut)) {
        await this.settlement.transfer({
          transactionId: tx.id,
          fromQuidaxId: mainId,
          toQuidaxId: subId,
          assetCode: quote.toAsset,
          amount: chunk,
          kind: SettlementLegKind.TRANSFER_OUT,
        });
      }

      const result = await this.settle(
        tx.id,
        userId,
        quote,
        ngnIn,
        coinOut,
        LedgerAccount.INVENTORY,
      );

      // A buy sells inventory to the user. Recording it here is what gives the
      // desk its "sold since refill" and weighted average received — without
      // this the dip alert has nothing to compare against and never fires.
      const rate = dec(quote.displayedRate as string);
      if (!rate.isZero() && coinOut.gt(0)) {
        const usdPricePerCoin = ngnIn.div(rate).div(coinOut);
        await this.inventory
          .recordSale(quote.toAsset, coinOut, usdPricePerCoin)
          .catch(() => undefined); // reporting must never fail a settled trade
      }

      return result;
    } catch (err) {
      return this.handleFailure(err, tx.id, userId, quote);
    }
  }

  // ── sell ────────────────────────────────────────────────────

  private async sell(
    userId: string,
    quote: {
      id: string;
      fromAsset: string;
      toAsset: string;
      fromAmount: unknown;
      toAmount: unknown;
      displayedRate: unknown;
      quidaxRate: unknown;
      usdValue: unknown;
      feeUsd: unknown;
      gateApplied: unknown;
      rateConfigId: string;
    },
  ): Promise<TradeResult> {
    await this.flags.assertTradingAllowed(quote.fromAsset);

    const coinIn = dec(quote.fromAmount as string);
    const ngnOut = dec(quote.toAmount as string);
    const asset = await this.assets.require(quote.fromAsset);

    const [mainId, subId] = await Promise.all([
      this.settlement.mainAccount(),
      this.settlement.quidaxIdFor(userId),
    ]);

    const tx = await this.prisma.serializable(async (t) => {
      await this.ledger.lock(t, userId, quote.fromAsset, coinIn);
      return t.transaction.create({
        data: {
          userId,
          type: TxType.SELL,
          status: TxStatus.PENDING,
          fromAsset: quote.fromAsset,
          fromAmount: coinIn.toFixed(),
          toAsset: 'ngn',
          toAmount: ngnOut.toFixed(),
          displayedRate: dec(quote.displayedRate as string).toFixed(),
          quidaxRate: dec(quote.quidaxRate as string).toFixed(),
          gateApplied: dec(quote.gateApplied as string).toFixed(),
          usdValue: quote.usdValue ? dec(quote.usdValue as string).toFixed() : null,
          feeUsd: quote.feeUsd ? dec(quote.feeUsd as string).toFixed() : null,
          rateConfigId: quote.rateConfigId,
          reference: this.quidax.newReference('sell'),
          settledFrom: 'INVENTORY',
        },
      });
    });

    try {
      // A sell never needs a swap: the coin comes off the user and lands in
      // inventory, and the naira owed is a ledger credit against the reserve.
      for (const chunk of this.assets.chunkForTransfer(asset, coinIn)) {
        await this.settlement.transfer({
          transactionId: tx.id,
          fromQuidaxId: subId,
          toQuidaxId: mainId,
          assetCode: quote.fromAsset,
          amount: chunk,
          kind: SettlementLegKind.TRANSFER_IN,
        });
      }

      return this.settle(tx.id, userId, quote, coinIn, ngnOut, LedgerAccount.INVENTORY);
    } catch (err) {
      return this.handleFailure(err, tx.id, userId, quote);
    }
  }

  // ── coin to coin ────────────────────────────────────────────

  private async swap(
    userId: string,
    quote: {
      id: string;
      fromAsset: string;
      toAsset: string;
      fromAmount: unknown;
      toAmount: unknown;
      displayedRate: unknown;
      usdValue: unknown;
      feeUsd: unknown;
      feeAmount: unknown;
      feeAsset: string | null;
      rateConfigId: string;
    },
  ): Promise<TradeResult> {
    await this.flags.assertTradingAllowed(quote.fromAsset);
    await this.flags.assertTradingAllowed(quote.toAsset);

    const amountIn = dec(quote.fromAmount as string);
    const netOut = dec(quote.toAmount as string);
    const fee = dec(quote.feeAmount as string);
    const subId = await this.settlement.quidaxIdFor(userId);

    const tx = await this.prisma.serializable(async (t) => {
      await this.ledger.lock(t, userId, quote.fromAsset, amountIn);
      return t.transaction.create({
        data: {
          userId,
          type: TxType.SWAP,
          status: TxStatus.PENDING,
          fromAsset: quote.fromAsset,
          fromAmount: amountIn.toFixed(),
          toAsset: quote.toAsset,
          toAmount: netOut.toFixed(),
          displayedRate: dec(quote.displayedRate as string).toFixed(),
          feeAmount: fee.toFixed(),
          feeAsset: quote.feeAsset,
          usdValue: quote.usdValue ? dec(quote.usdValue as string).toFixed() : null,
          feeUsd: quote.feeUsd ? dec(quote.feeUsd as string).toFixed() : null,
          rateConfigId: quote.rateConfigId,
          reference: this.quidax.newReference('swap'),
        },
      });
    });

    try {
      // Runs inside the user's own sub-account: the coin never crosses
      // accounts, so no transfer minimum applies and a failure leaves
      // everything exactly where it started.
      await this.settlement.swapInSubAccount({
        transactionId: tx.id,
        quidaxUserId: subId,
        fromCurrency: quote.fromAsset,
        toCurrency: quote.toAsset,
        fromAmount: amountIn,
      });

      // The fee is booked as a receivable, never collected now — it may be
      // below the destination coin's transfer minimum. An admin claim sweeps it.
      if (quote.feeAsset && fee.gt(0)) {
        const price = await this.prisma.rateSnapshot.findFirst({
          where: { assetCode: quote.feeAsset },
          orderBy: { capturedAt: 'desc' },
        });
        await this.prisma.$transaction([
          this.prisma.swapFee.create({
            data: {
              transactionId: tx.id,
              assetCode: quote.feeAsset,
              amount: fee.toFixed(),
              usdAtAccrual: price ? fee.mul(dec(price.priceUsd)).toFixed() : '0',
              rateConfigId: quote.rateConfigId,
            },
          }),
          this.prisma.feeReceivable.create({
            data: {
              userId,
              assetCode: quote.feeAsset,
              amount: fee.toFixed(),
              usdAtAccrual: price ? fee.mul(dec(price.priceUsd)).toFixed() : '0',
            },
          }),
        ]);
      }

      // confirmSwap returns "initiated". Completion arrives by webhook or the
      // poller, so the trade sits PROCESSING rather than claiming to be done.
      await this.prisma.transaction.update({
        where: { id: tx.id },
        data: { status: TxStatus.PROCESSING },
      });

      return {
        transactionId: tx.id,
        status: TxStatus.PROCESSING,
        fromAsset: quote.fromAsset,
        fromAmount: str(amountIn, 8),
        toAsset: quote.toAsset,
        toAmount: str(netOut, 8),
        rate: str(dec(quote.displayedRate as string), 8),
      };
    } catch (err) {
      return this.handleFailure(err, tx.id, userId, quote);
    }
  }

  // ── shared ──────────────────────────────────────────────────

  private async settle(
    transactionId: string,
    userId: string,
    quote: { fromAsset: string; toAsset: string; displayedRate: unknown },
    amountIn: ReturnType<typeof dec>,
    amountOut: ReturnType<typeof dec>,
    counterparty: LedgerAccount,
  ): Promise<TradeResult> {
    await this.prisma.serializable(async (t) => {
      await this.ledger.settleLocked(t, {
        userId,
        assetCode: quote.fromAsset,
        amount: amountIn,
        counterparty,
        transactionId,
        memo: `trade in`,
      });
      await this.ledger.credit(t, {
        userId,
        assetCode: quote.toAsset,
        amount: amountOut,
        counterparty,
        transactionId,
        memo: `trade out`,
      });
      await t.transaction.update({
        where: { id: transactionId },
        data: { status: TxStatus.COMPLETED, completedAt: new Date() },
      });
    });

    // A sale ends in naira; a purchase starts there. The two get different
    // emails because the figures read the opposite way round.
    const isSell = quote.toAsset === 'ngn';

    await this.notifications.notify({
      userId,
      transactionId,
      type: 'trade.completed',
      title: isSell
        ? `Sold ${str(amountIn, 8)} ${quote.fromAsset.toUpperCase()}`
        : `Bought ${str(amountOut, 8)} ${quote.toAsset.toUpperCase()}`,
      body: `Rate: ₦${str(dec(quote.displayedRate as string), 2)} per $1`,
      email: {
        key: isSell ? 'trade.sell.completed' : 'trade.buy.completed',
        variables: {
          fromAmount: str(amountIn, quote.fromAsset === 'ngn' ? 2 : 8),
          fromAsset: quote.fromAsset.toUpperCase(),
          toAmount: str(amountOut, quote.toAsset === 'ngn' ? 2 : 8),
          toAsset: quote.toAsset.toUpperCase(),
          rate: str(dec(quote.displayedRate as string), 2),
          transactionId,
        },
      },
    });

    // A completed trade can be the last thing standing between somebody and
    // their referral bonus. Never throws — see ReferralsService.evaluate.
    await this.referrals.evaluate(userId);

    return {
      transactionId,
      status: TxStatus.COMPLETED,
      fromAsset: quote.fromAsset,
      fromAmount: str(amountIn, quote.fromAsset === 'ngn' ? 2 : 8),
      toAsset: quote.toAsset,
      toAmount: str(amountOut, quote.toAsset === 'ngn' ? 2 : 8),
      rate: str(dec(quote.displayedRate as string), 4),
    };
  }

  /**
   * The refund rule, in one place.
   *
   * FAILED  -> release the lock, tell the user nothing was taken.
   * UNKNOWN -> RECONCILING. Funds stay locked. Never refund from here: the
   *            request may well have succeeded, and refunding an unknown is how
   *            a user ends up holding both the coin and their money.
   */
  private async handleFailure(
    err: unknown,
    transactionId: string,
    userId: string,
    quote: { fromAsset: string; toAsset: string; fromAmount: unknown; toAmount: unknown },
  ): Promise<TradeResult> {
    const reason = this.settlement.describe(err);

    if (this.settlement.isUnknown(err)) {
      await this.settlement.markReconciling(transactionId, reason);
      return {
        transactionId,
        status: TxStatus.RECONCILING,
        fromAsset: quote.fromAsset,
        fromAmount: str(dec(quote.fromAmount as string), 8),
        toAsset: quote.toAsset,
        toAmount: str(dec(quote.toAmount as string), 8),
        rate: '0',
      };
    }

    await this.settlement.reverse(transactionId, reason);
    throw new BadRequestException(`${reason}. Nothing was deducted from your balance.`);
  }

  async history(userId: string, limit = 50) {
    const rows = await this.prisma.transaction.findMany({
      where: { userId, type: { in: [TxType.BUY, TxType.SELL, TxType.SWAP] } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
    });

    return rows.map((t) => ({
      id: t.id,
      type: t.type,
      status: t.status,
      fromAsset: t.fromAsset,
      fromAmount: t.fromAmount ? str(t.fromAmount) : null,
      toAsset: t.toAsset,
      toAmount: t.toAmount ? str(t.toAmount) : null,
      rate: t.displayedRate ? str(t.displayedRate, 4) : null,
      // The app shows ₦0 — the gate lives inside the rate.
      fee: '0',
      reason: t.failureReason,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    }));
  }

  async get(userId: string, transactionId: string) {
    const tx = await this.prisma.transaction.findFirst({
      where: { id: transactionId, userId },
    });
    // Not theirs and not existing are the same answer, so ids cannot be probed.
    if (!tx) throw new NotFoundException('No such transaction');
    return {
      id: tx.id,
      type: tx.type,
      status: tx.status,
      fromAsset: tx.fromAsset,
      fromAmount: tx.fromAmount ? str(tx.fromAmount) : null,
      toAsset: tx.toAsset,
      toAmount: tx.toAmount ? str(tx.toAmount) : null,
      reason: tx.failureReason,
      createdAt: tx.createdAt,
      completedAt: tx.completedAt,
    };
  }
}
