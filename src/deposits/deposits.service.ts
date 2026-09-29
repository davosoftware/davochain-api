import { Injectable, Logger } from '@nestjs/common';
import { LedgerAccount, TxStatus, TxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { RatesService } from '../rates/rates.service';
import { KycLimitsService } from '../kyc/kyc-limits.service';
import { ProvisioningService } from '../users/provisioning.service';
import { NotificationsService } from '../notifications/notifications.service';
import { dec, str } from '../common/money';
import type { QuidaxDeposit } from '../quidax/quidax.types';

/**
 * Quidax deposit states, mapped onto ours. The raw upstream string is kept on
 * the transaction for support, because the vocabularies differ per endpoint —
 * webhooks send "Done", the list filter wants "done".
 */
const STATUS_MAP: Record<string, TxStatus> = {
  submitting: TxStatus.PENDING,
  submitted: TxStatus.PENDING,
  checked: TxStatus.PENDING,
  accepted: TxStatus.COMPLETED,
  on_hold: TxStatus.ON_HOLD,
  rejected: TxStatus.FAILED,
  failed: TxStatus.FAILED,
  failed_aml: TxStatus.FAILED,
  canceled: TxStatus.FAILED,
};

@Injectable()
export class DepositsService {
  private readonly log = new Logger(DepositsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly provisioning: ProvisioningService,
    private readonly notifications: NotificationsService,
    private readonly rates: RatesService,
    private readonly limits: KycLimitsService,
  ) {}

  /**
   * Deposits are credited from webhooks and NEVER from a balance reading.
   *
   * The credit happens exactly once, guarded by the unique reference — a
   * re-delivered event finds the transaction already COMPLETED and does nothing.
   */
  async applyWebhook(event: string, data: QuidaxDeposit): Promise<void> {
    const userId = await this.provisioning.findUserByQuidax({
      quidaxUserId: data.user?.id ?? null,
      quidaxSn: data.user?.sn ?? null,
    });
    if (!userId) {
      this.log.warn(`Deposit ${data.id} for an unknown user — ignoring`);
      return;
    }

    const assetCode = data.currency.toLowerCase();
    const amount = dec(data.amount);
    const reference = `quidax_deposit_${data.id}`;
    let status = STATUS_MAP[data.status?.toLowerCase()] ?? TxStatus.PENDING;

    /*
     * A naira deposit over the tier's limit is HELD, not refused.
     *
     * The money has already arrived — the bank transfer happened, and there is
     * nothing to reject. Crediting it anyway would defeat the limit, so it
     * waits for an admin instead, which is what ON_HOLD is for. Crypto is not
     * capped this way: a coin arriving in our own wallet moves no real money.
     */
    let heldReason: string | null = null;
    if (assetCode === 'ngn' && status === TxStatus.COMPLETED) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { kycTier: true },
      });
      const check = await this.limits.check(userId, user?.kycTier ?? 'TIER_0', 'deposit', amount);
      if (!check.allowed) {
        status = TxStatus.ON_HOLD;
        heldReason = check.reason ?? 'Over the deposit limit for this tier';
        this.log.warn(`Deposit ${data.id} held: ${heldReason}`);
      }
    }

    const asset = await this.prisma.asset.findUnique({ where: { code: assetCode } });
    if (!asset) {
      this.log.warn(`Deposit in unlisted asset ${assetCode} — recorded but not credited`);
    }

    const existing = await this.prisma.transaction.findUnique({ where: { reference } });

    // Already final. A duplicate delivery must not credit a second time.
    if (existing?.status === TxStatus.COMPLETED) return;

    /*
     * Priced at the moment it lands, so a deposit can be totalled beside the
     * trades. Best effort: a price lookup is a call to Quidax, and money
     * arriving must never be held up by one — a null costs a dashboard row,
     * not a credit.
     */
    const usdValue = await this.rates
      .price(assetCode)
      .then((price) =>
        assetCode === 'ngn'
          ? amount.div(price.ngnPerUsd).toFixed()
          : amount.mul(price.priceUsd).toFixed(),
      )
      .catch(() => null);

    const tx = existing
      ? await this.prisma.transaction.update({
          where: { id: existing.id },
          data: {
            status,
            quidaxRawStatus: data.status,
            failureReason: heldReason ?? data.reason ?? null,
            completedAt: status === TxStatus.COMPLETED ? new Date() : null,
            usdValue,
          },
        })
      : await this.prisma.transaction.create({
          data: {
            userId,
            type: TxType.DEPOSIT,
            status,
            toAsset: assetCode,
            toAmount: amount.toFixed(),
            usdValue,
            reference,
            quidaxRef: data.id,
            quidaxRawStatus: data.status,
            failureReason: heldReason ?? data.reason ?? null,
          },
        });

    if (status === TxStatus.COMPLETED && asset) {
      await this.prisma.serializable(async (t) => {
        await this.ledger.credit(t, {
          userId,
          assetCode,
          amount,
          counterparty: LedgerAccount.EXTERNAL,
          transactionId: tx.id,
          memo: `deposit ${data.txid ?? data.id}`,
        });
        await t.transaction.update({
          where: { id: tx.id },
          data: { completedAt: new Date() },
        });
      });
      this.log.log(`Credited ${amount.toFixed()} ${assetCode} to ${userId}`);
    }

    await this.notifyFor(event, {
      userId,
      transactionId: tx.id,
      assetCode,
      amount: str(amount, asset?.displayScale ?? 8),
      confirmations: data.payment_transaction,
      reason: data.reason,
    });
  }

  private async notifyFor(
    event: string,
    ctx: {
      userId: string;
      transactionId: string;
      assetCode: string;
      amount: string;
      confirmations?: { confirmations: number; required_confirmations: number };
      reason?: string | null;
    },
  ): Promise<void> {
    const symbol = ctx.assetCode.toUpperCase();

    switch (event) {
      case 'deposit.transaction.confirmation':
        return this.notifications.notify({
          userId: ctx.userId,
          transactionId: ctx.transactionId,
          type: 'deposit.detected',
          title: `${ctx.amount} ${symbol} incoming`,
          body: ctx.confirmations
            ? `Waiting for confirmations (${ctx.confirmations.confirmations}/${ctx.confirmations.required_confirmations}).`
            : 'Waiting for network confirmations.',
        });

      case 'deposit.successful':
        return this.notifications.notify({
          userId: ctx.userId,
          transactionId: ctx.transactionId,
          type: 'deposit.credited',
          title: `${ctx.amount} ${symbol} added`,
          body: `Your ${symbol} deposit is now available in your wallet.`,
          email: {
            key: 'deposit.credited',
            variables: {
              amount: ctx.amount,
              assetCode: symbol,
              transactionId: ctx.transactionId,
            },
          },
        });

      case 'deposit.on_hold':
        return this.notifications.notify({
          userId: ctx.userId,
          transactionId: ctx.transactionId,
          type: 'deposit.on_hold',
          title: `${symbol} deposit under review`,
          body: 'This is a routine check. Your funds are safe and we will update you shortly.',
          email: {
            key: 'deposit.on_hold',
            variables: {
              amount: ctx.amount,
              assetCode: symbol,
              transactionId: ctx.transactionId,
            },
          },
        });

      case 'deposit.failed_aml':
      case 'deposit.rejected':
        return this.notifications.notify({
          userId: ctx.userId,
          transactionId: ctx.transactionId,
          type: 'deposit.failed',
          title: `${symbol} deposit could not be completed`,
          body: ctx.reason
            ? `${ctx.reason}. Contact support if you believe this is an error.`
            : 'Please contact support — we can help sort this out.',
          email: {
            key: 'deposit.failed',
            variables: {
              amount: ctx.amount,
              assetCode: symbol,
              reason: ctx.reason ?? 'The provider did not give a reason',
              transactionId: ctx.transactionId,
            },
          },
        });
    }
  }

  async history(userId: string, limit = 50) {
    const rows = await this.prisma.transaction.findMany({
      where: { userId, type: TxType.DEPOSIT },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
    });

    return rows.map((t) => ({
      id: t.id,
      asset: t.toAsset,
      amount: t.toAmount ? str(t.toAmount) : null,
      status: t.status,
      reason: t.failureReason,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    }));
  }

  /**
   * Fill gaps left by lost webhooks. Delivery stops after five attempts and
   * then never resumes, so this is the only thing between a dropped event and
   * a deposit the user never received.
   */
  async sweepGaps(deposits: QuidaxDeposit[]): Promise<number> {
    let recovered = 0;
    for (const d of deposits) {
      const reference = `quidax_deposit_${d.id}`;
      const existing = await this.prisma.transaction.findUnique({ where: { reference } });
      if (existing?.status === TxStatus.COMPLETED) continue;
      await this.applyWebhook(
        d.status?.toLowerCase() === 'accepted'
          ? 'deposit.successful'
          : 'deposit.transaction.confirmation',
        d,
      );
      recovered++;
    }
    if (recovered > 0) this.log.warn(`Gap sweep recovered ${recovered} deposit(s)`);
    return recovered;
  }
}
