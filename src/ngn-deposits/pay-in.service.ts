import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AlertType, CollectionOutcome, NairaCollection, PaymentProvider, Prisma, TxStatus, TxType, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { KycLimitsService } from '../kyc/kyc-limits.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RatesService } from '../rates/rates.service';
import { Decimal, dec, str } from '../common/money';
import { JOBS, QUEUES, jobId } from '../common/queues';
import { redactIds } from '../common/redact';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { PayrepApi } from '../payrep/payrep.api';
import { PayrepError } from '../payrep/payrep.errors';
import type { PayrepCollection, PayrepCursor } from '../payrep/payrep.types';
import { depositBalances, depositLegs } from './deposit-legs';
import { nameMatches } from './name-match';
import { DepositIntake, type CollectionHint } from './payrep-webhook.controller';
import { VirtualAccountsService } from './virtual-accounts.service';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A reported payment Payrep still can't show after this is given up on, with an alert. */
const GIVE_UP_AFTER = 48 * HOUR;
const MAX_PAGES = 20;

/** Money that reached a balance, is held, or is going back. Never credited again. */
const MONEY_TAKEN: CollectionOutcome[] = [CollectionOutcome.CREDITED, CollectionOutcome.HELD, CollectionOutcome.REFUND_PENDING, CollectionOutcome.REFUNDED];

/** Outcomes nothing automatic will move on from, except Payrep contradicting a credit. */
export const SETTLED_OUTCOMES: CollectionOutcome[] = [...MONEY_TAKEN, CollectionOutcome.DISPUTED];

export type PayInReason = 'WEBHOOK' | 'SWEEP' | 'RECHECK';

export interface PayInJob {
  providerTransactionId: string;
  reason: PayInReason;
}

export interface PayInResult {
  outcome: CollectionOutcome;
  /** Whether this run moved the payment on. Only a change notifies anyone. */
  changed: boolean;
}

/** Payrep's record of one payment, cleaned: money as Decimal. */
interface Facts {
  amount: Decimal | null;
  fee: Decimal | null;
  settled: Decimal | null;
  status: string;
  channel: string | null;
  accountNumber: string | null;
  referenceNumber: string | null;
  sessionId: string | null;
  payerName: string | null;
  payerBankName: string | null;
  payerAccountMasked: string | null;
  providerCreatedAt: Date | null;
  transactionType: string | null;
}

type Credit = { kind: 'NOOP' } | { kind: 'FEE_MISMATCH' } | { kind: 'CREDITED' | 'HELD'; transactionId: string };

function money(v: string | null | undefined): Decimal | null {
  if (v === null || v === undefined || v === '') return null;
  try {
    const d = dec(v);
    return d.isFinite() && d.gte(0) ? d : null;
  } catch {
    return null;
  }
}

function factsOf(c: PayrepCollection): Facts {
  const amount = money(c.amount);
  // No charges field means Payrep kept nothing; a bad one makes the deposit DISPUTED below.
  const fee = c.fee === null ? dec(0) : money(c.fee);
  const created = c.createdAt ? new Date(c.createdAt) : null;
  return {
    amount,
    fee,
    settled: amount && fee ? amount.minus(fee) : null,
    status: c.status,
    channel: c.channel,
    accountNumber: c.accountNumber,
    referenceNumber: c.referenceNumber,
    sessionId: c.sessionId,
    payerName: c.payerName,
    payerBankName: c.payerBankName,
    payerAccountMasked: c.payerAccountMasked,
    providerCreatedAt: created && !Number.isNaN(created.getTime()) ? created : null,
    transactionType: c.transactionType,
  };
}

/** The facts as collection columns: money as exact text. */
function columns(f: Facts) {
  const m = (d: Decimal | null) => (d ? d.toFixed() : null);
  return {
    amount: m(f.amount),
    fee: m(f.fee),
    amountSettled: m(f.settled),
    channel: f.channel,
    providerStatus: f.status || null,
    accountNumber: f.accountNumber,
    referenceNumber: f.referenceNumber,
    sessionId: f.sessionId,
    payerName: f.payerName,
    payerBankName: f.payerBankName,
    payerAccountMasked: f.payerAccountMasked,
    providerCreatedAt: f.providerCreatedAt,
  };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const validDate = (s: string | null | undefined): Date | null => {
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

/**
 * Turns "Payrep says money arrived" into a credit, exactly once (spec 2026-10-20 §6).
 *
 * The webhook, the sweep and the re-check can all report the same payment at
 * the same moment. Every path ends here, and only Payrep's own record, read
 * back with fetch_transactions, is believed: the webhook body is a hint about
 * where to look, never about money. The credit is one serializable transaction
 * keyed on the unique reference payrep:payin:<id>, so a second run finds the
 * payment settled, or loses the race on the reference, and does nothing.
 */
@Injectable()
export class PayInService extends DepositIntake {
  private readonly log = new Logger(PayInService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payrep: PayrepApi,
    private readonly accounts: VirtualAccountsService,
    private readonly ledger: LedgerService,
    private readonly kycLimits: KycLimitsService,
    private readonly notifications: NotificationsService,
    private readonly rates: RatesService,
    private readonly alerts: OpsAlertsService,
    @InjectQueue(QUEUES.NAIRA_DEPOSITS) private readonly queue: Queue,
  ) {
    super();
  }

  /**
   * Record what we were told and queue the check. A webhook's hint is kept as
   * it first arrived; the sweep reads Payrep's own list, so it may correct where
   * to look (never what to credit: that is always Payrep's record).
   */
  async intake(hint: CollectionHint, source: 'WEBHOOK' | 'SWEEP'): Promise<void> {
    await this.prisma.nairaCollection.upsert({
      where: { providerTransactionId: hint.transactionId },
      create: {
        providerTransactionId: hint.transactionId,
        outcome: CollectionOutcome.UNVERIFIED,
        firstSource: source,
        accountNumber: hint.accountNumber,
        referenceNumber: hint.referenceNumber,
        webhookHint: hint as unknown as Prisma.InputJsonValue,
      },
      update:
        source === 'SWEEP'
          ? { accountNumber: hint.accountNumber, referenceNumber: hint.referenceNumber, webhookHint: hint as unknown as Prisma.InputJsonValue }
          : {},
    });
    await this.enqueue(hint.transactionId, source).catch((err: Error) => this.log.error(`Could not queue deposit ${hint.transactionId}: ${redactIds(err.message)}`));
  }

  /**
   * Webhook jobs share one id per payment, so Payrep's retries collapse while
   * one is queued. Sweep and re-check jobs get fresh ids, so a payment whose
   * webhook job failed is still looked at again.
   */
  async enqueue(providerTransactionId: string, reason: PayInReason): Promise<void> {
    const job: PayInJob = { providerTransactionId, reason };
    await this.queue.add(JOBS.PROCESS_NAIRA_PAYIN, job, {
      jobId: reason === 'WEBHOOK' ? jobId('ngnin', providerTransactionId) : jobId('ngnin', providerTransactionId, reason.toLowerCase(), Date.now()),
      attempts: 8,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  async processPayment(id: string): Promise<PayInResult> {
    const row = await this.prisma.nairaCollection.findUnique({ where: { providerTransactionId: id } });
    if (!row) throw new Error(`No collection row for Payrep payment ${id}`);
    if (row.outcome === CollectionOutcome.DISPUTED) return { outcome: row.outcome, changed: false };

    // 1. Ask Payrep. An unclear answer throws, and the job retries.
    let record: PayrepCollection | null;
    try {
      record = await this.confirm(row);
    } catch (err) {
      if (err instanceof PayrepError && err.kind === 'CONFIG') {
        await this.alerts.raise(AlertType.NAIRA_RAIL_CONFIG, 'config', 'Payrep refused to list our deposits', [redactIds(err.message)]);
      }
      throw err;
    }
    if (!record) {
      if (row.outcome === CollectionOutcome.NOT_FOUND) {
        // Already given up on and owners told; the re-check looks again every few hours.
        await this.touch(id);
        return { outcome: row.outcome, changed: false };
      }
      if (!MONEY_TAKEN.includes(row.outcome) && Date.now() - row.firstSeenAt.getTime() > GIVE_UP_AFTER) {
        await this.alerts.raise(AlertType.NGN_DEPOSIT_UNMATCHED, `notfound:${id}`, `Payrep has no record of reported deposit ${id} after 48 hours`, this.describeRow(row), DAY);
        return this.setOutcome(row, CollectionOutcome.NOT_FOUND);
      }
      await this.touch(id);
      throw new Error(`Payrep payment ${id} is not yet visible in fetch_transactions; will look again`);
    }

    // 2. Record its answer.
    const f = factsOf(record);
    const updated = await this.prisma.nairaCollection.update({
      where: { providerTransactionId: id },
      data: { ...columns(f), lastCheckedAt: new Date(), checkCount: { increment: 1 } },
    });
    if (MONEY_TAKEN.includes(updated.outcome)) return this.recheckTaken(updated, f);

    // 3. A credit into one of our accounts, and final? Only values we know move it on;
    //    anything else waits where the re-check sees it, and owners are told (final review I1).
    const type = f.transactionType;
    if (type === 'debit' || type === 'dr') return this.setOutcome(updated, CollectionOutcome.NON_CUSTOMER);
    if (type && type !== 'credit' && type !== 'cr') {
      await this.alerts.raise(AlertType.NGN_RECONCILIATION, `unknown-type:${id}`, `Naira payment ${id} has a type DavoChain doesn't know: "${type}"`, [
        ...this.describe(id, f),
        'Not credited. It is looked at again by the re-check; update the code once the meaning of this type is known.',
      ], DAY);
      return { outcome: updated.outcome, changed: false };
    }
    if (f.status === 'failed' || f.status === 'reversed') return this.setOutcome(updated, CollectionOutcome.PROVIDER_FAILED);
    if (f.status !== 'success' && f.status !== 'successful') {
      if (f.status !== 'pending' && f.status !== 'processing') {
        this.log.warn(`Payrep payment ${id} has status "${f.status}"; treated as pending`);
        await this.alerts.raise(AlertType.NGN_RECONCILIATION, `unknown-status:${id}`, `Naira payment ${id} has a status DavoChain doesn't know: "${f.status}"`, [
          ...this.describe(id, f),
          'Treated as pending (not credited). It is looked at again for 8 days; update the code once the meaning of this status is known.',
        ], DAY);
      }
      return this.setOutcome(updated, CollectionOutcome.PENDING_PROVIDER);
    }

    // 4. Whose is it? Only Payrep's record of the account paid counts.
    const owner = f.accountNumber ? await this.accounts.findOwnerByAccount(f.accountNumber) : null;
    if (!owner) {
      await this.alerts.raise(AlertType.NGN_DEPOSIT_UNMATCHED, `unmatched:${id}`, `Naira deposit could not be matched to a customer: ₦${f.amount?.toFixed() ?? '?'}`, this.describe(id, f), DAY);
      return this.setOutcome(updated, CollectionOutcome.UNMATCHED);
    }

    // 5. Credit or hold, once.
    return this.credit(id, owner.userId, f, owner.switchedOff);
  }

  /** Payrep's own record of this payment, or null when it isn't there (yet). Throws when Payrep can't answer. */
  private async confirm(row: NairaCollection): Promise<PayrepCollection | null> {
    const hint = (row.webhookHint ?? {}) as Partial<CollectionHint>;
    const reported = validDate(hint.createdAt) ?? row.firstSeenAt;
    const from = new Date(Math.min(reported.getTime(), row.firstSeenAt.getTime()) - DAY);
    const to = new Date(Math.max(Date.now(), reported.getTime()) + DAY);
    const filters = {
      accountNumber: row.accountNumber ?? undefined,
      referenceNumber: row.referenceNumber ?? undefined,
      startDate: ymd(from),
      endDate: ymd(to),
    };
    const found = await this.search(filters, row.providerTransactionId);
    if (found || (!filters.accountNumber && !filters.referenceNumber)) return found;
    // On the sandbox (22 Oct 2026) the account filter missed a payment the plain list showed:
    // look again by date only. The match is still on the exact id, so nothing else can be picked up.
    return this.search({ startDate: filters.startDate, endDate: filters.endDate }, row.providerTransactionId);
  }

  private async search(filters: { accountNumber?: string; referenceNumber?: string; startDate: string; endDate: string }, id: string): Promise<PayrepCollection | null> {
    let cursor: PayrepCursor | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { items, next } = await this.payrep.fetchCredits(filters, cursor);
      const hit = items.find((c) => c.transactionId === id);
      if (hit) return hit;
      // No next page, or Payrep ignored the cursor (the same page again): not there yet.
      if (!next || (cursor && next.createdAt === cursor.createdAt && next.id === cursor.id)) return null;
      cursor = next;
    }
    return null;
  }

  // ── crediting ─────────────────────────────────────────────

  private async credit(id: string, userId: string, f: Facts, switchedOff: boolean): Promise<PayInResult> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.status === UserStatus.CLOSED) {
      this.log.warn(`Payrep payment ${id} is for closed account ${userId}; credited as received`);
    }
    const balanced = depositBalances(f.amount, f.settled, f.fee);
    // Network calls stay outside the database transaction, which may be re-run.
    const usdValue = balanced && f.amount ? await this.usdValue(f.amount) : null;
    const fx = await this.kycLimits.fx();
    const nameMismatch = nameMatches(user.firstName, user.lastName, f.payerName) === false;

    let result: Credit;
    try {
      result = await this.prisma.serializable(
        async (t): Promise<Credit> => {
          const current = await t.nairaCollection.findUnique({ where: { providerTransactionId: id } });
          if (!current || SETTLED_OUTCOMES.includes(current.outcome)) return { kind: 'NOOP' };
          if (!balanced || !f.amount || !f.settled || !f.fee) {
            await t.nairaCollection.update({
              where: { providerTransactionId: id },
              data: { outcome: CollectionOutcome.DISPUTED, previousOutcome: current.outcome, userId },
            });
            return { kind: 'FEE_MISMATCH' };
          }

          // Before this deposit exists: the check sums today's deposits and must not count it twice.
          const limit = await this.kycLimits.checkInTransaction(t, userId, user.kycTier, 'deposit', f.amount, fx);
          // Payrep can't switch an account off (no API), so an "off" account's deposits wait for a person.
          const holdReason = switchedOff
            ? 'Deposit account switched off by an admin or compliance'
            : !limit.allowed
              ? (limit.reason ?? 'Over the deposit limit for this tier')
              : null;
          const held = holdReason !== null;
          const created = await t.transaction.create({
            data: {
              userId,
              type: TxType.DEPOSIT,
              status: held ? TxStatus.ON_HOLD : TxStatus.COMPLETED,
              toAsset: 'ngn',
              toAmount: f.amount.toFixed(),
              usdValue,
              reference: `payrep:payin:${id}`,
              provider: PaymentProvider.PAYREP,
              providerRef: id,
              providerFee: f.fee.toFixed(),
              providerSettledAmount: f.settled.toFixed(),
              counterpartyName: f.payerName,
              counterpartyBank: f.payerBankName,
              counterpartyAccountMasked: f.payerAccountMasked,
              nameMismatch,
              failureReason: holdReason,
              completedAt: held ? null : new Date(),
            },
          });
          if (!held) {
            await this.ledger.post(t, depositLegs({ userId, amount: f.amount, settled: f.settled, fee: f.fee, memo: `payrep deposit ${id}` }), created.id);
          }
          await t.nairaCollection.update({
            where: { providerTransactionId: id },
            data: { outcome: held ? CollectionOutcome.HELD : CollectionOutcome.CREDITED, previousOutcome: current.outcome, userId, transactionId: created.id },
          });
          return { kind: held ? 'HELD' : 'CREDITED', transactionId: created.id };
        },
        { conflict: 'This deposit is being credited by another worker' },
      );
    } catch (err) {
      // A concurrent run took the unique reference first: it did the work.
      if ((err as { code?: string }).code !== 'P2002') throw err;
      this.log.log(`Payrep payment ${id} was settled by a concurrent run`);
      result = { kind: 'NOOP' };
    }

    if (result.kind === 'NOOP') {
      const now = await this.prisma.nairaCollection.findUnique({ where: { providerTransactionId: id } });
      // A clash on anything but a finished deposit (say, a balance-row race) must retry, not complete the job.
      if (!now || !SETTLED_OUTCOMES.includes(now.outcome)) throw new Error(`Payrep payment ${id} is not settled after a conflict; retrying`);
      return { outcome: now.outcome, changed: false };
    }
    if (result.kind === 'FEE_MISMATCH') {
      await this.alerts.raise(
        AlertType.NGN_RECONCILIATION,
        `disputed:${id}`,
        `Naira deposit ${id} not credited: the fee is larger than the amount, or a figure is missing`,
        [...this.describe(id, f), `Fee: ₦${f.fee?.toFixed() ?? '?'}`],
        6 * HOUR,
      );
      return { outcome: CollectionOutcome.DISPUTED, changed: true };
    }
    const amount = f.amount as Decimal;
    if (result.kind === 'HELD') {
      await this.notifyHeld(userId, result.transactionId, amount);
      return { outcome: CollectionOutcome.HELD, changed: true };
    }
    if (nameMismatch) this.log.warn(`Payrep payment ${id} credited; the sender's name differs from ${userId}'s`);
    await this.notifyCredited(userId, result.transactionId, amount);
    return { outcome: CollectionOutcome.CREDITED, changed: true };
  }

  // ── when Payrep contradicts us ────────────────────────────

  private async recheckTaken(row: NairaCollection, f: Facts): Promise<PayInResult> {
    if (f.status === 'failed' || f.status === 'reversed') {
      return this.dispute(row, `Payrep now reports a credited deposit as ${f.status}`, ['Nothing was clawed back. Review the payment and the balance.']);
    }
    const recorded = row.transactionId ? await this.prisma.transaction.findUnique({ where: { id: row.transactionId } }) : null;
    if (recorded?.toAmount && f.amount && !dec(recorded.toAmount).eq(f.amount)) {
      return this.dispute(row, 'the confirmed amount differs from what was recorded', [
        `Recorded: ₦${dec(recorded.toAmount).toFixed()}`,
        `Payrep now: ₦${f.amount.toFixed()}`,
      ]);
    }
    return { outcome: row.outcome, changed: false };
  }

  private async dispute(row: NairaCollection, reason: string, lines: string[]): Promise<PayInResult> {
    const result = await this.setOutcome(row, CollectionOutcome.DISPUTED);
    if (result.changed) {
      await this.alerts.raise(
        AlertType.NGN_RECONCILIATION,
        `disputed:${row.providerTransactionId}`,
        `Naira deposit ${row.providerTransactionId} needs review: ${reason}`,
        [`Payrep id: ${row.providerTransactionId}`, `User: ${row.userId ?? 'unknown'}`, ...lines],
        6 * HOUR,
      );
    }
    return result;
  }

  /** Move the payment on, only if nobody else moved it since we read it. */
  private async setOutcome(row: NairaCollection, outcome: CollectionOutcome): Promise<PayInResult> {
    if (row.outcome === outcome) return { outcome, changed: false };
    const { count } = await this.prisma.nairaCollection.updateMany({
      where: { providerTransactionId: row.providerTransactionId, outcome: row.outcome },
      data: { outcome, previousOutcome: row.outcome },
    });
    if (count > 0) return { outcome, changed: true };
    const now = await this.prisma.nairaCollection.findUnique({ where: { providerTransactionId: row.providerTransactionId } });
    return { outcome: now?.outcome ?? row.outcome, changed: false };
  }

  // ── small helpers ─────────────────────────────────────────

  private touch(id: string) {
    return this.prisma.nairaCollection.update({ where: { providerTransactionId: id }, data: { lastCheckedAt: new Date(), checkCount: { increment: 1 } } });
  }

  private describe(id: string, f: Facts): string[] {
    return [
      `Payrep id: ${id}`,
      `Amount: ₦${f.amount?.toFixed() ?? '?'}`,
      `Account paid: ${f.accountNumber ?? 'unknown'}`,
      `Sender: ${f.payerName ?? 'unknown'}, ${f.payerBankName ?? 'unknown bank'}`,
    ];
  }

  private describeRow(r: NairaCollection): string[] {
    return [`Payrep id: ${r.providerTransactionId}`, `Account (as reported): ${r.accountNumber ?? 'unknown'}`, `First seen: ${r.firstSeenAt.toISOString()} via ${r.firstSource}`];
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
