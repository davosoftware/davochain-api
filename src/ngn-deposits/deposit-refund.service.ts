import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, OnModuleInit, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AdminRole, AlertType, CollectionOutcome, NairaCollection, PaymentProvider, TxStatus, TxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { JobLeaseService } from '../common/job-lease.service';
import { dec, str } from '../common/money';
import { redactIds } from '../common/redact';
import { PayrepApi } from '../payrep/payrep.api';
import type { PayrepCollection, PayrepCursor } from '../payrep/payrep.types';
import { NAIRA_RAIL, type NairaRail, RailRefusedError, RailUnknownError } from '../naira-rail/naira-rail';
import { RailTransferHooks } from '../naira-rail/rail-transfer-hooks';

export const REFUND_REF_PREFIX = 'dvc_rfd_';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_PAGES = 20;
const BEING_RETURNED = 'Being returned to the sender: ';
const RETURNED = 'Returned to the sender: ';
const RETURNED_OUTSIDE = 'Returned to the sender outside DavoChain: ';
const RETURN_FAILED = 'Returning it to the sender failed, so it is held again for review.';
const DEALT_WITH = 'That deposit was already dealt with';

/** Our transfer reference for returning one payment: the collection id without dashes. */
export function refundReference(collectionId: string): string {
  return `${REFUND_REF_PREFIX}${collectionId.replace(/-/g, '')}`;
}

/** The collection id back from a reference, or null when the reference isn't one of ours. */
function collectionIdOf(reference: string): string | null {
  const hex = reference.startsWith(REFUND_REF_PREFIX) ? reference.slice(REFUND_REF_PREFIX.length) : '';
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const last4 = (account: string) => `******${account.slice(-4)}`;

/**
 * Sends a held Payrep deposit back to the account it came from (plan 2026-10-22
 * Task 6), when an admin rejects it.
 *
 * A held deposit was never posted to the ledger, so returning it moves no
 * customer balance: only the naira at Payrep goes out (any transfer fee is
 * DavoChain's cost). The owner's rule holds throughout: only Payrep's clear
 * "no" puts the deposit back on hold at once; an unclear answer stays
 * REFUND_PENDING and Payrep's own record decides, through the webhook or the
 * 10-minute recheck. The sender's full account number is used for the transfer
 * only: never stored, never logged (last 4 only).
 */
@Injectable()
export class DepositRefundService implements OnModuleInit {
  private readonly log = new Logger(DepositRefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NAIRA_RAIL) private readonly rail: NairaRail,
    private readonly payrep: PayrepApi,
    private readonly notifications: NotificationsService,
    private readonly alerts: OpsAlertsService,
    @Optional() private readonly leases?: JobLeaseService,
    @Optional() private readonly hooks?: RailTransferHooks,
  ) {}

  onModuleInit(): void {
    // Payrep's transfer webhook for one of our returns: ask Payrep what happened.
    this.hooks?.on(REFUND_REF_PREFIX, (reference) => this.recheck(reference));
  }

  async start(transactionId: string, reason: string, adminId: string): Promise<{ status: 'RETURNING' | 'RETURNED' }> {
    const tx = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    const row = await this.prisma.nairaCollection.findUnique({ where: { transactionId } });
    if (
      !tx || !row || tx.type !== TxType.DEPOSIT || tx.status !== TxStatus.ON_HOLD ||
      tx.provider !== PaymentProvider.PAYREP || row.outcome !== CollectionOutcome.HELD
    ) {
      throw new ConflictException(DEALT_WITH);
    }

    // 1. Payrep's own record of the payment: the only source of the sender's account.
    let payment: PayrepCollection | null;
    try {
      payment = await this.find(row);
    } catch {
      throw new ServiceUnavailableException('We could not reach Payrep to find the sender. Nothing was sent. Try again shortly.');
    }
    if (!payment?.payerAccountNumber || !payment.payerBankCode) {
      throw new ConflictException("Payrep did not give the sender's account for this deposit. Return it from the Payrep dashboard, then mark it.");
    }
    const amount = dec(row.amount ?? tx.toAmount ?? 0);
    if (amount.lte(0) || (payment.amount && !dec(payment.amount).eq(amount))) {
      throw new ConflictException('The amount Payrep shows differs from what we recorded. Nothing was sent; check the payment first.');
    }

    // An earlier return for this deposit (the reference is fixed per deposit): never send twice.
    // After a failed return, the money goes back from the Payrep dashboard and an owner marks it.
    const reference = refundReference(row.id);
    let earlier;
    try {
      earlier = await this.rail.transferStatus(reference);
    } catch {
      throw new ServiceUnavailableException(`We could not check with ${this.rail.name} whether this deposit was already returned. Nothing was sent. Try again shortly.`);
    }
    if (earlier) {
      throw new ConflictException(
        `A return for this deposit was already sent to ${this.rail.name} (${earlier.status.toLowerCase()}), so nothing was sent again. ` +
          'Check it in the Payrep dashboard; if the money went back from there, an owner uses Mark returned.',
      );
    }

    // 2. Claim it, once: of two admins (or two clicks), only one moves HELD on.
    const { count } = await this.prisma.nairaCollection.updateMany({
      where: { id: row.id, outcome: CollectionOutcome.HELD },
      data: { outcome: CollectionOutcome.REFUND_PENDING, previousOutcome: CollectionOutcome.HELD },
    });
    if (count === 0) throw new ConflictException(DEALT_WITH);
    const holdReason = tx.failureReason;
    await this.prisma.transaction.update({ where: { id: tx.id }, data: { failureReason: `${BEING_RETURNED}${reason}`.slice(0, 500) } });

    // 3. Send once.
    try {
      await this.rail.transfer({
        reference,
        bankCode: payment.payerBankCode,
        accountNumber: payment.payerAccountNumber,
        amount,
        narration: 'DavoChain deposit returned',
      });
    } catch (err) {
      if (err instanceof RailRefusedError) {
        // A clear "no": nothing left, so it is simply held again.
        await this.prisma.nairaCollection.updateMany({
          where: { id: row.id, outcome: CollectionOutcome.REFUND_PENDING },
          data: { outcome: CollectionOutcome.HELD, previousOutcome: CollectionOutcome.REFUND_PENDING },
        });
        await this.prisma.transaction.update({ where: { id: tx.id }, data: { failureReason: holdReason } });
        throw new ConflictException(`${this.rail.name} refused to send it back, so nothing was sent: ${err.message}`);
      }
      // Unclear (RailUnknownError or anything else): it may have gone. Payrep's record decides.
      this.log.warn(
        `Returning deposit ${row.providerTransactionId} to ${last4(payment.payerAccountNumber)}: unclear answer, kept pending (${redactIds((err as Error).message)})`,
      );
    }
    this.log.log(`Admin ${adminId} is returning deposit ${row.providerTransactionId} (₦${amount.toFixed(2)}) to ${last4(payment.payerAccountNumber)}`);
    return { status: 'RETURNING' };
  }

  /** Ask the rail about one of our returns and finish it once. Anything unclear changes nothing. */
  async recheck(reference: string): Promise<void> {
    const id = collectionIdOf(reference);
    if (!id) return;
    const row = await this.prisma.nairaCollection.findUnique({ where: { id } });
    if (!row || row.outcome !== CollectionOutcome.REFUND_PENDING || !row.transactionId) return;

    let t;
    try {
      t = await this.rail.transferStatus(reference);
    } catch (err) {
      if (err instanceof RailUnknownError) return;
      throw err;
    }
    if (!t || t.status === 'PENDING') return;

    if (t.status === 'SUCCESSFUL') {
      const tx = await this.prisma.transaction.findUnique({ where: { id: row.transactionId } });
      const reason = tx?.failureReason?.startsWith(BEING_RETURNED) ? tx.failureReason.slice(BEING_RETURNED.length) : 'returned by DavoChain';
      await this.close(row, [CollectionOutcome.REFUND_PENDING], `${RETURNED}${reason}`, reason);
      return;
    }

    const { count } = await this.prisma.nairaCollection.updateMany({
      where: { id, outcome: CollectionOutcome.REFUND_PENDING },
      data: { outcome: CollectionOutcome.HELD, previousOutcome: CollectionOutcome.REFUND_PENDING },
    });
    if (count === 0) return;
    await this.prisma.transaction.update({ where: { id: row.transactionId }, data: { failureReason: RETURN_FAILED } });
    await this.alerts.raise(
      AlertType.NGN_RECONCILIATION,
      `refund-failed:${row.providerTransactionId}`,
      `Returning deposit ${row.providerTransactionId} to its sender failed`,
      [
        `Payrep id: ${row.providerTransactionId}`,
        `Our reference: ${reference}`,
        `Payrep says: ${t.reason ?? 'failed'}`,
        'The deposit is held again. Release it, or return it from the Payrep dashboard.',
      ],
      6 * HOUR,
    );
  }

  /**
   * The money went back outside DavoChain (from the Payrep dashboard): an owner,
   * with a note, closes the deposit so it can never be released afterwards
   * (final review, Important 1). Refused while our own return is still going
   * through, so the sender is never paid twice.
   */
  async markReturned(transactionId: string, note: string, actor: { id: string; role: string }): Promise<void> {
    if (actor.role !== AdminRole.OWNER) throw new ForbiddenException('Only an owner can mark a deposit returned outside DavoChain');
    const text = (note ?? '').trim();
    if (text.length < 10) throw new BadRequestException('Write a note (at least 10 characters) saying how it was returned');
    const tx = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    const row = await this.prisma.nairaCollection.findUnique({ where: { transactionId } });
    const open: CollectionOutcome[] = [CollectionOutcome.HELD, CollectionOutcome.REFUND_PENDING];
    if (!tx || !row || tx.type !== TxType.DEPOSIT || tx.status !== TxStatus.ON_HOLD || tx.provider !== PaymentProvider.PAYREP || !open.includes(row.outcome)) {
      throw new ConflictException(DEALT_WITH);
    }
    let ours;
    try {
      ours = await this.rail.transferStatus(refundReference(row.id));
    } catch {
      throw new ServiceUnavailableException(`We could not check our own return with ${this.rail.name}. Nothing changed. Try again shortly.`);
    }
    if (ours?.status === 'PENDING') {
      throw new ConflictException(`Our return of this deposit is still going through at ${this.rail.name}. Wait for it to finish; it closes by itself.`);
    }
    if (ours?.status === 'SUCCESSFUL') {
      throw new ConflictException(`${this.rail.name} shows our own return went through. It closes by itself within 10 minutes; do not return it again.`);
    }
    // The owner's note is for the team; the customer sees the reason given at Reject, if there was one.
    const customerReason = tx.failureReason?.startsWith(BEING_RETURNED) ? tx.failureReason.slice(BEING_RETURNED.length) : null;
    const closed = await this.close(row, open, `${RETURNED_OUTSIDE}${text}`, customerReason);
    if (!closed) throw new ConflictException(DEALT_WITH);
    this.log.log(`Owner ${actor.id} marked deposit ${row.providerTransactionId} returned outside DavoChain`);
  }

  /** Closes a deposit as returned, once, and tells the customer. False when someone else moved it first. */
  private async close(row: NairaCollection, from: CollectionOutcome[], failureReason: string, reason: string | null): Promise<boolean> {
    const txId = row.transactionId!;
    const tx = await this.prisma.transaction.findUnique({ where: { id: txId } });
    const finished = await this.prisma.$transaction(async (t) => {
      const { count } = await t.nairaCollection.updateMany({
        where: { id: row.id, outcome: { in: from } },
        data: { outcome: CollectionOutcome.REFUNDED, previousOutcome: row.outcome },
      });
      if (count === 0) return false;
      await t.transaction.update({
        where: { id: txId },
        data: { status: TxStatus.FAILED, failureReason: failureReason.slice(0, 500), completedAt: new Date() },
      });
      return true;
    });
    if (!finished || !tx) return false;

    const amount = `₦${Number(dec(row.amount ?? tx.toAmount ?? 0).toFixed(2)).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const body = `We returned your naira deposit of ${amount} to the account it came from.${reason ? ` Reason: ${reason}` : ''}`;
    try {
      await this.notifications.notify({
        userId: tx.userId,
        transactionId: tx.id,
        type: 'deposit.failed',
        title: 'Naira deposit returned',
        body,
        email: {
          key: 'deposit.failed',
          variables: { amount: str(dec(row.amount ?? tx.toAmount ?? 0), 2), assetCode: 'NGN', reason: body, transactionId: tx.reference },
        },
      });
    } catch (err) {
      this.log.error(`Could not tell ${tx.userId} their deposit ${tx.id} was returned: ${redactIds((err as Error).message)}`);
    }
    return true;
  }

  /** Backup for a lost webhook: every 10 minutes, ask about every return still under way. */
  @Cron('*/10 * * * *', { name: 'naira-refund-recheck' })
  async recheckOpenCron(): Promise<void> {
    if (!this.leases) return this.recheckOpen();
    await this.leases.run('naira-refund-recheck', 8 * 60_000, () => this.recheckOpen());
  }

  async recheckOpen(): Promise<void> {
    const open = await this.prisma.nairaCollection.findMany({
      where: { outcome: CollectionOutcome.REFUND_PENDING },
      select: { id: true, providerTransactionId: true, updatedAt: true },
    });
    for (const r of open) {
      await this.recheck(refundReference(r.id)).catch((err: Error) => this.log.warn(`Could not re-check return of ${r.providerTransactionId}: ${redactIds(err.message)}`));
      // Still unclear a day later: a person has to look (the owner's rule: never assume).
      if (r.updatedAt && Date.now() - new Date(r.updatedAt).getTime() > DAY) {
        await this.alerts.raise(
          AlertType.NGN_RECONCILIATION,
          `refund-stuck:${r.providerTransactionId}`,
          `Returning deposit ${r.providerTransactionId} is still unconfirmed after a day`,
          [`Our reference: ${refundReference(r.id)}`, 'Check it in the Payrep dashboard. Nothing is assumed; it stays pending until Payrep answers.'],
          DAY,
        );
      }
    }
  }

  /** The payment in Payrep's credit list, around the day it arrived, matched on its exact id. */
  private async find(row: NairaCollection): Promise<PayrepCollection | null> {
    const at = row.providerCreatedAt ?? row.firstSeenAt;
    const filters = { startDate: ymd(new Date(at.getTime() - DAY)), endDate: ymd(new Date(Math.max(Date.now(), at.getTime()) + DAY)) };
    let cursor: PayrepCursor | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { items, next } = await this.payrep.fetchCredits(filters, cursor);
      const hit = items.find((c) => c.transactionId === row.providerTransactionId);
      if (hit) return hit;
      if (!next || (cursor && next.createdAt === cursor.createdAt && next.id === cursor.id)) return null;
      cursor = next;
    }
    return null;
  }
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
