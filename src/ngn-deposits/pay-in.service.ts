import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  AlertType,
  CollectionOutcome,
  FlutterwaveCollection,
  PaymentProvider,
  TxStatus,
  TxType,
  UserStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { KycLimitsService } from '../kyc/kyc-limits.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RatesService } from '../rates/rates.service';
import { Decimal, dec, str } from '../common/money';
import { JOBS, QUEUES, jobId } from '../common/queues';
import { FlutterwaveClient } from '../flutterwave/flutterwave.client';
import { FlutterwaveError, redactIds } from '../flutterwave/flutterwave.errors';
import type { FlwTransaction } from '../flutterwave/flutterwave.types';
import { depositBalances, depositLegs } from './deposit-legs';
import { nameMatches } from './name-match';
import { OpsAlertsService } from './ops-alerts.service';
import { VirtualAccountsService } from './virtual-accounts.service';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Money that reached a balance, is held, or is going back. Never credited again. */
const MONEY_TAKEN: CollectionOutcome[] = [
  CollectionOutcome.CREDITED,
  CollectionOutcome.HELD,
  CollectionOutcome.REFUND_PENDING,
  CollectionOutcome.REFUNDED,
];

/** Outcomes nothing automatic will move on from, except Flutterwave contradicting a credit. */
export const SETTLED_OUTCOMES: CollectionOutcome[] = [...MONEY_TAKEN, CollectionOutcome.DISPUTED];

export type PayInReason = 'WEBHOOK' | 'SWEEP' | 'RECHECK';

export interface PayInJob {
  flwTransactionId: string;
  reason: PayInReason;
}

export interface PayInResult {
  outcome: CollectionOutcome;
  /** Whether this run moved the payment on. Only a change notifies anyone. */
  changed: boolean;
}

/** Flutterwave's verify answer, cleaned: money as Decimal, text trimmed, "N/A" as null. */
interface Facts {
  txRef: string | null;
  flwRef: string | null;
  virtualAccountNumber: string | null;
  amount: Decimal | null;
  chargedAmount: Decimal | null;
  appFee: Decimal | null;
  merchantFee: Decimal | null;
  amountSettled: Decimal | null;
  currency: string | null;
  paymentType: string | null;
  providerStatus: string | null;
  payerName: string | null;
  payerBankName: string | null;
  payerBankCode: string | null;
  payerAccountMasked: string | null;
  providerCreatedAt: Date | null;
}

type Credit = { kind: 'NOOP' } | { kind: 'FEE_MISMATCH' } | { kind: 'CREDITED' | 'HELD'; transactionId: string };

function money(v: string | null | undefined): Decimal | null {
  if (v === null || v === undefined || v === '') return null;
  try {
    const d = dec(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

function text(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && t.toUpperCase() !== 'N/A' ? t.slice(0, max) : null;
}

function factsOf(tx: FlwTransaction): Facts {
  const created = tx.created_at ? new Date(tx.created_at) : null;
  return {
    txRef: text(tx.tx_ref),
    flwRef: text(tx.flw_ref),
    virtualAccountNumber: text(tx.meta?.virtualaccountnumber, 20),
    amount: money(tx.amount),
    chargedAmount: money(tx.charged_amount),
    appFee: money(tx.app_fee),
    merchantFee: money(tx.merchant_fee),
    amountSettled: money(tx.amount_settled),
    currency: text(tx.currency, 10),
    paymentType: text(tx.payment_type, 50),
    providerStatus: text(tx.status, 50),
    payerName: text(tx.meta?.originatorname),
    payerBankName: text(tx.meta?.bankname),
    payerBankCode: text(tx.meta?.bankcode, 20),
    payerAccountMasked: text(tx.meta?.originatoraccountnumber, 30),
    providerCreatedAt: created && !Number.isNaN(created.getTime()) ? created : null,
  };
}

/** The facts as collection columns: money as exact text. */
function columns(f: Facts) {
  const m = (d: Decimal | null) => (d ? d.toFixed() : null);
  return {
    ...f,
    amount: m(f.amount),
    chargedAmount: m(f.chargedAmount),
    appFee: m(f.appFee),
    merchantFee: m(f.merchantFee),
    amountSettled: m(f.amountSettled),
  };
}

/**
 * Turns "Flutterwave says money arrived" into a credit, exactly once (spec §6.5).
 *
 * A webhook, the sweep and the re-check pass can all report the same payment,
 * at the same moment. Every path ends here, and here only Flutterwave's answer
 * to our own authenticated verify counts: the webhook body is never trusted.
 * The credit is one serializable transaction keyed on the unique reference
 * flw:payin:<id>, so a second run finds the payment settled, or loses the race
 * on the reference, and does nothing.
 */
@Injectable()
export class PayInService {
  private readonly log = new Logger(PayInService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: FlutterwaveClient,
    private readonly accounts: VirtualAccountsService,
    private readonly ledger: LedgerService,
    private readonly kycLimits: KycLimitsService,
    private readonly notifications: NotificationsService,
    private readonly rates: RatesService,
    private readonly alerts: OpsAlertsService,
    @InjectQueue(QUEUES.FLUTTERWAVE) private readonly queue: Queue,
  ) {}

  /**
   * Webhook jobs share one id per payment, so Flutterwave's retries collapse
   * while one is queued. Sweep and re-check jobs get fresh ids, so a payment
   * whose webhook job failed is still looked at again.
   */
  async enqueue(flwTransactionId: string, reason: PayInReason): Promise<void> {
    const job: PayInJob = { flwTransactionId, reason };
    await this.queue.add(JOBS.PROCESS_FLW_PAYIN, job, {
      jobId:
        reason === 'WEBHOOK'
          ? jobId('flwin', flwTransactionId)
          : jobId('flwin', flwTransactionId, reason.toLowerCase(), Date.now()),
      attempts: 8,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  async processPayment(
    id: string,
    firstSource: 'WEBHOOK' | 'SWEEP' | 'SETTLEMENT' = 'SWEEP',
  ): Promise<PayInResult> {
    // 1. Ask Flutterwave. Unknown answers throw, and the job retries.
    let tx: FlwTransaction;
    try {
      tx = await this.client.verifyTransaction(id);
    } catch (err) {
      return this.verifyFailed(id, firstSource, err);
    }
    if (String(tx.id) !== id) {
      throw new Error(`Flutterwave answered about payment ${String(tx.id)} when asked about ${id}`);
    }

    // 2. Record its answer.
    const facts = factsOf(tx);
    const now = new Date();
    const row = await this.prisma.flutterwaveCollection.upsert({
      where: { flwTransactionId: id },
      create: {
        flwTransactionId: id,
        outcome: CollectionOutcome.UNVERIFIED,
        firstSource,
        ...columns(facts),
        lastCheckedAt: now,
        checkCount: 1,
      },
      update: { ...columns(facts), lastCheckedAt: now, checkCount: { increment: 1 } },
    });

    if (row.outcome === CollectionOutcome.DISPUTED) return { outcome: row.outcome, changed: false };
    if (MONEY_TAKEN.includes(row.outcome)) return this.recheckTaken(row, facts);

    // 3. Is it a customer deposit, and is it final?
    const status = (facts.providerStatus ?? '').toLowerCase();
    if ((facts.paymentType ?? '').toLowerCase() !== 'bank_transfer') {
      return this.setOutcome(row, CollectionOutcome.NON_CUSTOMER);
    }
    if ((facts.currency ?? '').toUpperCase() !== 'NGN') {
      await this.alerts.raise(
        AlertType.NGN_DEPOSIT_UNMATCHED,
        `currency:${id}`,
        `Naira-account payment ${id} arrived in ${facts.currency ?? 'no currency'}`,
        this.describe(id, facts),
        DAY,
      );
      return this.setOutcome(row, CollectionOutcome.UNMATCHED);
    }
    if (status === 'failed') return this.setOutcome(row, CollectionOutcome.PROVIDER_FAILED);
    if (status !== 'successful') {
      if (status !== 'pending') {
        this.log.warn(`Flutterwave payment ${id} has status "${facts.providerStatus ?? ''}"; treated as pending`);
      }
      return this.setOutcome(row, CollectionOutcome.PENDING_PROVIDER);
    }

    // 4. Whose is it?
    const owner = await this.accounts.findOwner(facts.txRef, facts.virtualAccountNumber);
    if (!owner) {
      await this.alerts.raise(
        AlertType.NGN_DEPOSIT_UNMATCHED,
        `unmatched:${id}`,
        `Naira deposit could not be matched to a customer: ₦${facts.amount?.toFixed() ?? '?'}`,
        this.describe(id, facts),
        DAY,
      );
      return this.setOutcome(row, CollectionOutcome.UNMATCHED);
    }
    if (owner.via === 'TX_REF' && !owner.accountKnown && facts.virtualAccountNumber) {
      await this.accounts.recordDiscovered(owner.userId, facts.virtualAccountNumber);
    }

    // 5. Credit or hold, once.
    return this.credit(id, owner.userId, facts);
  }

  // ── crediting ─────────────────────────────────────────────

  private async credit(id: string, userId: string, f: Facts): Promise<PayInResult> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.status === UserStatus.CLOSED) {
      this.log.warn(`Flutterwave payment ${id} is for closed account ${userId}; credited as received`);
    }
    const balanced = depositBalances(f.amount, f.amountSettled, f.appFee);
    // Network calls stay outside the database transaction, which may be re-run.
    const usdValue = balanced && f.amount ? await this.usdValue(f.amount) : null;
    const nameMismatch = nameMatches(user.firstName, user.lastName, f.payerName) === false;

    let result: Credit;
    try {
      result = await this.prisma.serializable(
        async (t): Promise<Credit> => {
          const current = await t.flutterwaveCollection.findUnique({ where: { flwTransactionId: id } });
          if (!current || SETTLED_OUTCOMES.includes(current.outcome)) return { kind: 'NOOP' };
          if (!balanced || !f.amount || !f.amountSettled || !f.appFee) {
            await t.flutterwaveCollection.update({
              where: { flwTransactionId: id },
              data: { outcome: CollectionOutcome.DISPUTED, previousOutcome: current.outcome, userId },
            });
            return { kind: 'FEE_MISMATCH' };
          }

          // Before this deposit exists: the check sums today's deposits and must not count it twice.
          const limit = await this.kycLimits.checkInTransaction(t, userId, user.kycTier, 'deposit', f.amount);
          const held = !limit.allowed;
          const created = await t.transaction.create({
            data: {
              userId,
              type: TxType.DEPOSIT,
              status: held ? TxStatus.ON_HOLD : TxStatus.COMPLETED,
              toAsset: 'ngn',
              toAmount: f.amount.toFixed(),
              usdValue,
              reference: `flw:payin:${id}`,
              provider: PaymentProvider.FLUTTERWAVE,
              providerRef: id,
              providerFee: f.appFee.toFixed(),
              providerSettledAmount: f.amountSettled.toFixed(),
              counterpartyName: f.payerName,
              counterpartyBank: f.payerBankName,
              counterpartyAccountMasked: f.payerAccountMasked,
              nameMismatch,
              failureReason: held ? (limit.reason ?? 'Over the deposit limit for this tier') : null,
              completedAt: held ? null : new Date(),
            },
          });
          if (!held) {
            await this.ledger.post(
              t,
              depositLegs({ userId, amount: f.amount, settled: f.amountSettled, fee: f.appFee, memo: `flutterwave deposit ${id}` }),
              created.id,
            );
          }
          await t.flutterwaveCollection.update({
            where: { flwTransactionId: id },
            data: {
              outcome: held ? CollectionOutcome.HELD : CollectionOutcome.CREDITED,
              previousOutcome: current.outcome,
              userId,
              transactionId: created.id,
            },
          });
          return { kind: held ? 'HELD' : 'CREDITED', transactionId: created.id };
        },
        { conflict: 'This deposit is being credited by another worker' },
      );
    } catch (err) {
      // A concurrent run took the unique reference first: it did the work.
      if ((err as { code?: string }).code !== 'P2002') throw err;
      this.log.log(`Flutterwave payment ${id} was settled by a concurrent run`);
      result = { kind: 'NOOP' };
    }

    if (result.kind === 'NOOP') {
      const now = await this.prisma.flutterwaveCollection.findUnique({ where: { flwTransactionId: id } });
      // A clash on anything but a finished deposit (say, a balance-row race) must retry, not complete the job.
      if (!now || !SETTLED_OUTCOMES.includes(now.outcome)) {
        throw new Error(`Flutterwave payment ${id} is not settled after a conflict; retrying`);
      }
      return { outcome: now.outcome, changed: false };
    }
    if (result.kind === 'FEE_MISMATCH') {
      await this.alerts.raise(
        AlertType.NGN_RECONCILIATION,
        `disputed:${id}`,
        `Naira deposit ${id} not credited: the amount is not the settled amount plus the fee`,
        [...this.describe(id, f), `Settled: ₦${f.amountSettled?.toFixed() ?? '?'}`, `Fee: ₦${f.appFee?.toFixed() ?? '?'}`],
        6 * HOUR,
      );
      return { outcome: CollectionOutcome.DISPUTED, changed: true };
    }
    const amount = f.amount as Decimal;
    if (result.kind === 'HELD') {
      await this.notifyHeld(userId, result.transactionId, amount);
      return { outcome: CollectionOutcome.HELD, changed: true };
    }
    if (nameMismatch) this.log.warn(`Flutterwave payment ${id} credited; the sender's name differs from ${userId}'s`);
    await this.notifyCredited(userId, result.transactionId, amount);
    return { outcome: CollectionOutcome.CREDITED, changed: true };
  }

  // ── when Flutterwave contradicts us, or can't answer ──────

  private async recheckTaken(row: FlutterwaveCollection, f: Facts): Promise<PayInResult> {
    if ((f.providerStatus ?? '').toLowerCase() === 'failed') {
      return this.dispute(row, 'Flutterwave now reports a credited deposit as failed', [
        'Nothing was clawed back (decision D7). Review the payment and the balance.',
      ]);
    }
    const recorded = row.transactionId
      ? await this.prisma.transaction.findUnique({ where: { id: row.transactionId } })
      : null;
    if (recorded?.toAmount && f.amount && !dec(recorded.toAmount).eq(f.amount)) {
      return this.dispute(row, 'the verified amount differs from what was recorded', [
        `Recorded: ₦${dec(recorded.toAmount).toFixed()}`,
        `Verified now: ₦${f.amount.toFixed()}`,
      ]);
    }
    return { outcome: row.outcome, changed: false };
  }

  private async verifyFailed(id: string, firstSource: string, err: unknown): Promise<PayInResult> {
    if (err instanceof FlutterwaveError && err.kind === 'NOT_FOUND') {
      const now = new Date();
      const row = await this.prisma.flutterwaveCollection.upsert({
        where: { flwTransactionId: id },
        create: { flwTransactionId: id, outcome: CollectionOutcome.NOT_FOUND, firstSource, lastCheckedAt: now, checkCount: 1 },
        update: { lastCheckedAt: now, checkCount: { increment: 1 } },
      });
      this.log.warn(`Flutterwave has no payment ${id} (reported by ${firstSource})`);
      if (row.outcome === CollectionOutcome.UNVERIFIED) return this.setOutcome(row, CollectionOutcome.NOT_FOUND);
      return { outcome: row.outcome, changed: row.outcome === CollectionOutcome.NOT_FOUND && row.checkCount === 1 };
    }
    if (err instanceof FlutterwaveError && err.kind === 'CONFIG') {
      await this.alerts.raise(AlertType.FLUTTERWAVE_CONFIG, 'config', 'Flutterwave refused to verify a payment', [
        redactIds(err.message),
      ]);
    }
    throw err;
  }

  private async dispute(row: FlutterwaveCollection, reason: string, lines: string[]): Promise<PayInResult> {
    const result = await this.setOutcome(row, CollectionOutcome.DISPUTED);
    if (result.changed) {
      await this.alerts.raise(
        AlertType.NGN_RECONCILIATION,
        `disputed:${row.flwTransactionId}`,
        `Naira deposit ${row.flwTransactionId} needs review: ${reason}`,
        [`Flutterwave id: ${row.flwTransactionId}`, `User: ${row.userId ?? 'unknown'}`, ...lines],
        6 * HOUR,
      );
    }
    return result;
  }

  /** Move the payment on, only if nobody else moved it since we read it. */
  private async setOutcome(row: FlutterwaveCollection, outcome: CollectionOutcome): Promise<PayInResult> {
    if (row.outcome === outcome) return { outcome, changed: false };
    const { count } = await this.prisma.flutterwaveCollection.updateMany({
      where: { flwTransactionId: row.flwTransactionId, outcome: row.outcome },
      data: { outcome, previousOutcome: row.outcome },
    });
    if (count > 0) return { outcome, changed: true };
    const now = await this.prisma.flutterwaveCollection.findUnique({ where: { flwTransactionId: row.flwTransactionId } });
    return { outcome: now?.outcome ?? row.outcome, changed: false };
  }

  // ── small helpers ─────────────────────────────────────────

  private describe(id: string, f: Facts): string[] {
    return [
      `Flutterwave id: ${id}`,
      `Amount: ₦${f.amount?.toFixed() ?? '?'}`,
      `tx_ref: ${f.txRef ?? 'none'}`,
      `Account paid: ${f.virtualAccountNumber ?? 'unknown'}`,
      `Sender: ${f.payerName ?? 'unknown'}, ${f.payerBankName ?? 'unknown bank'}`,
    ];
  }

  /** Best effort: a missing price costs a dashboard figure, never a credit. */
  private async usdValue(amount: Decimal): Promise<string | null> {
    try {
      const price = await this.rates.price('ngn');
      return amount.div(price.ngnPerUsd).toFixed();
    } catch {
      return null;
    }
  }

  private async notifyCredited(userId: string, transactionId: string, amount: Decimal): Promise<void> {
    try {
      await this.notifications.notify({
        userId,
        transactionId,
        type: 'deposit.credited',
        title: `₦${str(amount, 2)} added`,
        body: 'Your naira deposit is now in your balance.',
        email: { key: 'ngn.deposit.credited', variables: { amount: str(amount, 2), transactionId } },
      });
    } catch (err) {
      this.log.error(`Could not notify ${userId} of deposit ${transactionId}: ${redactIds((err as Error).message)}`);
    }
  }

  private async notifyHeld(userId: string, transactionId: string, amount: Decimal): Promise<void> {
    try {
      await this.notifications.notify({
        userId,
        transactionId,
        type: 'deposit.on_hold',
        title: 'Naira deposit under review',
        body: 'This is a routine check. Your money is safe and we will update you shortly.',
        email: { key: 'deposit.on_hold', variables: { amount: str(amount, 2), assetCode: 'NGN', transactionId } },
      });
    } catch (err) {
      this.log.error(`Could not notify ${userId} of held deposit ${transactionId}: ${redactIds((err as Error).message)}`);
    }
  }
}
