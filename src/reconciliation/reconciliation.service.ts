import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { JobLeaseService } from '../common/job-lease.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AdminRole, AlertType, LegState, SettlementLegKind, TxStatus, TxType } from '@prisma/client';
import { OPEN_STATUSES } from '../trades/close-open';
import { PrismaService } from '../prisma/prisma.service';
import { QuidaxClient } from '../quidax/quidax.client';
import { LedgerService } from '../ledger/ledger.service';
import { SettlementService } from '../trades/settlement.service';
import { DepositsService } from '../deposits/deposits.service';
import { InventoryService } from '../inventory/inventory.service';
import { Decimal, ZERO, dec } from '../common/money';
import { NAIRA_RAIL, type NairaRail } from '../naira-rail/naira-rail';
import { railAsWithdrawal, railEvent } from '../naira-rail/rail-as-withdrawal';

export interface DriftRow {
  asset: string;
  ledgerTotal: string;
  receivableTotal: string;
  lockedTotal: string;
  /** What Quidax actually holds across the scanned sub-accounts. */
  heldInSubAccounts: string;
  drift: string;
  withinTolerance: boolean;
  /** True when some sub-account could not be read, so drift proves nothing. */
  partial: boolean;
}

export type MismatchReason = 'BEING_CHECKED' | 'IN_PROGRESS' | 'UNEXPLAINED' | 'UNREADABLE';

export interface CustomerMismatches {
  asset: string;
  checkedAt: string;
  /** True when some sub-account could not be read, or there were more holders than one check reads. */
  partial: boolean;
  rows: Array<{
    userId: string;
    name: string;
    email: string;
    /** available + locked + uncollected fees, in our records. */
    recorded: string;
    /** What Quidax holds in their sub-account; null when it could not be read. */
    held: string | null;
    /** recorded − held; positive means our records say more than Quidax holds. */
    difference: string | null;
    unreadable: boolean;
    open: Array<{ id: string; type: TxType; status: TxStatus; createdAt: Date }>;
    reason: MismatchReason;
  }>;
}

/**
 * Three jobs, all of them things that go wrong silently.
 *
 *  1. The invariant. Any drift is an unswept fee, an in-flight settlement, or
 *     a bug — and you want to know which in minutes, not at month end.
 *  2. Stuck legs. A leg in UNKNOWN is a transaction whose outcome nobody knows;
 *     it is resolved by POLLING Quidax, never by retrying blind.
 *  3. Webhook gaps. Delivery stops after five attempts and never resumes, so
 *     this is the only thing between a dropped event and a lost deposit.
 */
@Injectable()
export class ReconciliationService {
  private readonly log = new Logger(ReconciliationService.name);
  private static readonly TOLERANCE = '0.00000001';
  /** Bounded so a reconciliation sweep can never monopolise the rate limit. */
  private static readonly MAX_USERS_PER_RUN = 200;

  constructor(
    private readonly prisma: PrismaService,
    private readonly quidax: QuidaxClient,
    private readonly ledger: LedgerService,
    private readonly settlement: SettlementService,
    private readonly deposits: DepositsService,
    private readonly inventory: InventoryService,
    @Optional() private readonly leases?: JobLeaseService,
    /** H11: customer naira payouts are checked with the naira rail, never Quidax. */
    @Optional() @Inject(NAIRA_RAIL) private readonly rail?: NairaRail,
  ) {}

  /**
   * The custody invariant, per asset:
   *
   *   Σ(user ledger + locked + unswept fee receivables) == Σ(sub-account balances)
   *
   * Compare like with like. User coins live in their SUB-ACCOUNTS; the main
   * wallet holds the desk's own inventory, which no user has a claim on. An
   * earlier version compared user obligations against the main wallet, which
   * are different pools — it reported drift on every asset forever, and an
   * alert that always fires is an alert nobody reads.
   *
   * Only users holding something are scanned, and the scan is bounded, so the
   * cost tracks holders rather than signups.
   */
  async checkInvariants(): Promise<DriftRow[]> {
    const assets = await this.prisma.asset.findMany({
      where: { isListed: true, isFiat: false },
      select: { code: true },
    });
    const crypto = new Set(assets.map((a) => a.code));

    // Everyone with a non-zero position, or an unswept fee sitting in their
    // sub-account. One wallets call each, however many assets they hold.
    const [holders, receivables] = await Promise.all([
      this.prisma.balance.findMany({
        where: {
          assetCode: { in: [...crypto] },
          OR: [{ available: { gt: 0 } }, { locked: { gt: 0 } }],
        },
        select: { userId: true, assetCode: true, available: true, locked: true },
      }),
      this.prisma.feeReceivable.findMany({
        where: { sweptAt: null, assetCode: { in: [...crypto] } },
        select: { userId: true, assetCode: true, amount: true },
      }),
    ]);

    // What we believe each user is owed, per asset.
    const owedByAsset = new Map<string, Decimal>();
    const userIds = new Set<string>();
    const add = (asset: string, amount: Decimal) =>
      owedByAsset.set(asset, (owedByAsset.get(asset) ?? ZERO).plus(amount));

    for (const b of holders) {
      userIds.add(b.userId);
      add(b.assetCode, dec(b.available).plus(dec(b.locked)));
    }
    for (const r of receivables) {
      userIds.add(r.userId);
      add(r.assetCode, dec(r.amount));
    }

    // What Quidax actually holds in those sub-accounts.
    const heldByAsset = new Map<string, Decimal>();
    let scanned = 0;
    let unreadable = 0;

    for (const userId of [...userIds].slice(0, ReconciliationService.MAX_USERS_PER_RUN)) {
      let subId: string;
      try {
        subId = await this.settlement.quidaxIdFor(userId);
      } catch {
        unreadable++;
        continue; // not provisioned yet — they cannot be holding anything
      }

      try {
        for (const wallet of await this.quidax.fetchWallets(subId)) {
          const code = wallet.currency?.toLowerCase();
          if (!code || !crypto.has(code)) continue;
          heldByAsset.set(code, (heldByAsset.get(code) ?? ZERO).plus(dec(wallet.balance || '0')));
        }
        scanned++;
      } catch {
        // A network blip must not be reported as missing customer funds.
        unreadable++;
      }
    }

    if (unreadable > 0) {
      this.log.warn(
        `Reconciliation could not read ${unreadable} sub-account(s); treating this run as partial`,
      );
    }
    // H4: more holders than one run scans means "held" covers only some of
    // them while "owed" covers everyone. That difference is not drift.
    const truncated = userIds.size > ReconciliationService.MAX_USERS_PER_RUN;
    if (truncated) {
      this.log.warn(
        `Reconciliation scanned ${ReconciliationService.MAX_USERS_PER_RUN} of ${userIds.size} holders; treating this run as partial`,
      );
    }
    const partial = unreadable > 0 || truncated;

    const rows: DriftRow[] = [];
    for (const code of crypto) {
      const owed = owedByAsset.get(code) ?? ZERO;
      const held = heldByAsset.get(code) ?? ZERO;

      // Nothing owed and nothing held is the normal state for an unused coin.
      if (owed.isZero() && held.isZero()) continue;

      const totals = await this.ledger.projectedTotals(code);
      const drift = owed.minus(held);

      rows.push({
        asset: code,
        ledgerTotal: totals.userTotal.toFixed(),
        receivableTotal: totals.receivableTotal.toFixed(),
        lockedTotal: totals.lockedTotal.toFixed(),
        heldInSubAccounts: held.toFixed(),
        drift: drift.toFixed(),
        // A partial scan cannot prove a shortfall, so never claim one.
        withinTolerance: partial ? true : drift.abs().lte(dec(ReconciliationService.TOLERANCE)),
        partial,
      });
    }

    this.log.debug(`Reconciled ${scanned} sub-account(s) across ${rows.length} asset(s)`);
    return rows;
  }

  /**
   * One coin, customer by customer: whose record doesn't match what their
   * sub-account holds, and the likely reason (the reconciliation screen).
   * Bounded like the totals check. A sub-account that can't be read is listed
   * as unreadable: it proves nothing, so it is never reported as missing money.
   */
  async customersFor(asset: string): Promise<CustomerMismatches> {
    const code = asset.toLowerCase();
    const listed = await this.prisma.asset.findFirst({ where: { code, isListed: true, isFiat: false }, select: { code: true } });
    if (!listed) throw new BadRequestException('Choose a listed coin');

    const [holders, receivables] = await Promise.all([
      this.prisma.balance.findMany({
        where: { assetCode: code, OR: [{ available: { gt: 0 } }, { locked: { gt: 0 } }] },
        select: { userId: true, available: true, locked: true },
      }),
      this.prisma.feeReceivable.findMany({ where: { sweptAt: null, assetCode: code }, select: { userId: true, amount: true } }),
    ]);
    const recorded = new Map<string, Decimal>();
    const add = (id: string, v: Decimal) => recorded.set(id, (recorded.get(id) ?? ZERO).plus(v));
    for (const h of holders) add(h.userId, dec(h.available).plus(dec(h.locked)));
    for (const r of receivables) add(r.userId, dec(r.amount));

    const all = [...recorded.keys()];
    const scanned = all.slice(0, ReconciliationService.MAX_USERS_PER_RUN);
    let partial = all.length > scanned.length;
    const found: Array<{ userId: string; recorded: Decimal; held: Decimal | null }> = [];
    for (const userId of scanned) {
      let held: Decimal | null = null;
      try {
        const subId = await this.settlement.quidaxIdFor(userId);
        held = ZERO;
        for (const w of await this.quidax.fetchWallets(subId)) {
          if (w.currency?.toLowerCase() === code) held = held.plus(dec(w.balance || '0'));
        }
      } catch {
        held = null;
        partial = true;
      }
      const mine = recorded.get(userId) ?? ZERO;
      if (held !== null && mine.minus(held).abs().lte(dec(ReconciliationService.TOLERANCE))) continue;
      found.push({ userId, recorded: mine, held });
    }

    const ids = found.map((f) => f.userId);
    const [people, open] = ids.length
      ? await Promise.all([
          this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true, email: true } }),
          this.prisma.transaction.findMany({
            where: {
              userId: { in: ids },
              status: { in: [TxStatus.PENDING, TxStatus.PROCESSING, TxStatus.RECONCILING] },
              OR: [{ fromAsset: code }, { toAsset: code }],
            },
            select: { id: true, userId: true, type: true, status: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
          }),
        ])
      : [[], []];

    return {
      asset: code,
      checkedAt: new Date().toISOString(),
      partial,
      rows: found.map((f) => {
        const person = people.find((p) => p.id === f.userId);
        const mine = open.filter((t) => t.userId === f.userId).map(({ id, type, status, createdAt }) => ({ id, type, status, createdAt }));
        const reason: MismatchReason =
          f.held === null
            ? 'UNREADABLE'
            : mine.some((t) => t.status === TxStatus.RECONCILING)
              ? 'BEING_CHECKED'
              : mine.length > 0
                ? 'IN_PROGRESS'
                : 'UNEXPLAINED';
        return {
          userId: f.userId,
          name: person ? `${person.firstName} ${person.lastName}` : '',
          email: person?.email ?? '',
          recorded: f.recorded.toFixed(),
          held: f.held?.toFixed() ?? null,
          difference: f.held === null ? null : f.recorded.minus(f.held).toFixed(),
          unreadable: f.held === null,
          open: mine,
          reason,
        };
      }),
    };
  }

  /**
   * Resolve legs whose outcome is unknown by asking Quidax what happened.
   * This is the ONLY correct response to a timeout on a write.
   */
  async resolveStuckLegs(): Promise<number> {
    const stuck = await this.prisma.settlementLeg.findMany({
      where: {
        OR: [
          { state: { in: [LegState.UNKNOWN, LegState.SENT] }, updatedAt: { lt: new Date(Date.now() - 60_000) } },
          // H4: a crash between creating a leg and sending it leaves it PENDING.
          // Checked by reference too, once it is old enough to be stuck.
          { state: LegState.PENDING, updatedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
        ],
      },
      include: { transaction: true },
      // Oldest first, so a backlog cannot starve the oldest legs.
      orderBy: { updatedAt: 'asc' },
      take: 50,
    });

    let resolved = 0;
    // Buys and sells whose legs changed: each is then settled or refunded as a whole.
    const touched = new Set<string>();
    for (const leg of stuck) {
      try {
        // H4: a swap is not a withdrawal; asking the withdrawals endpoint about
        // one never finds it.
        if (leg.kind === SettlementLegKind.SWAP) {
          if (await this.resolveSwapLeg(leg, touched)) resolved++;
          continue;
        }

        // H11: a naira payout went through the naira rail; ask the rail by our reference.
        if (leg.kind === SettlementLegKind.BANK_PAYOUT && this.rail) {
          const t = await this.rail.transferStatus(leg.reference);
          if (!t || t.status === 'PENDING') continue;
          await this.settlement.applyWithdrawalWebhook(railEvent(t), railAsWithdrawal(t));
          resolved++;
          continue;
        }

        // A TRANSFER_IN was sent BY the sub-account (sell, fee sweep); everything
        // else was sent by main. Asking the wrong account returns 404 and the leg
        // stays stuck forever.
        const sender =
          leg.kind === SettlementLegKind.TRANSFER_IN
            ? await this.settlement.quidaxIdFor(leg.transaction.userId)
            : 'me';

        const upstream = await this.quidax.fetchWithdrawalByReference(leg.reference, sender);
        if (!upstream) continue;

        const status = upstream.status?.toLowerCase();
        if (status === 'done') {
          if (leg.transaction.type === 'WITHDRAWAL') {
            // This also consumes the locked user balance and completes the
            // parent transaction; a leg-only update would strand the debit.
            await this.settlement.applyWithdrawalWebhook('withdraw.successful', upstream);
          } else {
            await this.prisma.settlementLeg.update({
              where: { id: leg.id },
              data: { state: LegState.CONFIRMED, quidaxRef: upstream.id },
            });
            touched.add(leg.transactionId);
          }
          resolved++;
          continue;
        }

        if (status === 'rejected' || status === 'failed') {
          if (leg.transaction.type === 'WITHDRAWAL') {
            await this.settlement.applyWithdrawalWebhook('withdraw.rejected', upstream);
          } else {
            await this.prisma.settlementLeg.update({
              where: { id: leg.id },
              data: { state: LegState.FAILED, quidaxRef: upstream.id },
            });
            touched.add(leg.transactionId);
          }
          resolved++;
        }
        // Processing/unknown states remain open and will be checked next run.
      } catch (err) {
        this.log.warn('Could not resolve leg ' + leg.reference + ': ' + (err as Error).message);
      }
    }

    for (const transactionId of touched) {
      await this.settleOrRelease(transactionId).catch((err: Error) =>
        this.log.warn('Could not finish ' + transactionId + ': ' + err.message),
      );
    }
    return resolved;
  }

  /**
   * H4: a swap leg, looked up in the swap list of the account that ran it: the
   * user's sub-account for a coin-to-coin swap, the main account for a buy's
   * fallback swap. Without the swap id (the confirm never answered) it cannot
   * be found, and is left for an owner to resolve.
   */
  private async resolveSwapLeg(
    leg: { id: string; transactionId: string; quidaxRef: string | null; transaction: { type: string; userId: string } },
    touched: Set<string>,
  ): Promise<boolean> {
    if (!leg.quidaxRef) return false;
    const isUserSwap = leg.transaction.type === TxType.SWAP;
    const owner = isUserSwap ? await this.settlement.quidaxIdFor(leg.transaction.userId) : 'me';
    const swap = (await this.quidax.fetchSwapTransactions(owner)).find((s) => s.id === leg.quidaxRef);
    const status = swap?.status?.toLowerCase();

    if (status === 'completed') {
      await this.prisma.settlementLeg.update({ where: { id: leg.id }, data: { state: LegState.CONFIRMED } });
      if (isUserSwap) await this.settlement.finaliseSwap(leg.transactionId);
      else touched.add(leg.transactionId);
      return true;
    }
    if (status === 'failed') {
      await this.prisma.settlementLeg.update({ where: { id: leg.id }, data: { state: LegState.FAILED } });
      if (isUserSwap) await this.settlement.reverse(leg.transactionId, 'The swap could not be completed');
      else touched.add(leg.transactionId);
      return true;
    }
    return false;
  }

  /**
   * H4: decide a buy or sell as a whole, from all of its legs.
   *  - every leg confirmed, and the transfers add up to the trade: settle it;
   *  - a leg failed and nothing else went out: refund it (nothing happened);
   *  - anything else (part done, part failed): leave it for an owner.
   */
  private async settleOrRelease(transactionId: string): Promise<void> {
    const tx = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!tx || !OPEN_STATUSES.includes(tx.status)) return;
    if (tx.type !== TxType.BUY && tx.type !== TxType.SELL) return;

    const legs = await this.prisma.settlementLeg.findMany({ where: { transactionId } });
    const transferKind = tx.type === TxType.BUY ? SettlementLegKind.TRANSFER_OUT : SettlementLegKind.TRANSFER_IN;
    const expected = dec(tx.type === TxType.BUY ? tx.toAmount! : tx.fromAmount!);

    if (legs.length > 0 && legs.every((l) => l.state === LegState.CONFIRMED)) {
      const moved = legs.filter((l) => l.kind === transferKind).reduce((sum, l) => sum.plus(dec(l.amount)), ZERO);
      if (moved.eq(expected)) await this.settlement.completeTrade(transactionId);
      return;
    }

    const failed = legs.some((l) => l.state === LegState.FAILED);
    const wentOut = legs.some((l) => l.state === LegState.SENT || l.state === LegState.CONFIRMED || l.state === LegState.UNKNOWN);
    const pending = legs.some((l) => l.state === LegState.PENDING);
    if (failed && !wentOut && !pending) {
      await this.settlement.reverse(transactionId, 'Confirmed failed upstream');
    }
  }

  /**
   * H4: an owner decides a transaction the reconciler could not (a swap whose
   * confirm never answered, a trade half done, a payout Quidax has no record
   * of). Owner only, a written note, and only from RECONCILING. The outcome
   * goes through the same run-once paths as the automatic flow, so a late
   * webhook afterwards changes nothing. Open legs are closed so the reconciler
   * stops polling them.
   */
  async resolveByOwner(
    actor: { id: string; role: AdminRole },
    transactionId: string,
    outcome: 'COMPLETED' | 'FAILED',
    note: string,
  ): Promise<{ transactionId: string; outcome: 'COMPLETED' | 'FAILED' }> {
    if (actor.role !== AdminRole.OWNER) {
      throw new ForbiddenException('Only an owner can resolve a transaction that is being checked');
    }
    const reason = (note ?? '').trim();
    if (reason.length < 10) {
      throw new BadRequestException('Write a note (at least 10 characters) saying what you checked');
    }
    const tx = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!tx) throw new NotFoundException('Transaction not found');
    if (tx.status !== TxStatus.RECONCILING) {
      throw new ConflictException('Only a transaction that is being checked (RECONCILING) can be resolved');
    }

    if (outcome === 'FAILED') {
      await this.settlement.reverse(tx.id, `Resolved by an owner: ${reason}`);
    } else if (tx.type === TxType.BUY || tx.type === TxType.SELL) {
      await this.settlement.completeTrade(tx.id);
    } else if (tx.type === TxType.SWAP) {
      await this.settlement.finaliseSwap(tx.id);
    } else if (tx.type === TxType.WITHDRAWAL) {
      await this.settlement.applyWithdrawalWebhook('withdraw.successful', {
        id: tx.quidaxRef ?? `owner-resolved-${tx.id}`,
        reference: tx.reference,
        status: 'Done',
        fee: tx.networkFee ?? '0',
        txid: null,
      } as never);
    } else {
      throw new BadRequestException(`A ${tx.type.toLowerCase()} cannot be resolved here`);
    }

    await this.prisma.settlementLeg.updateMany({
      where: { transactionId: tx.id, state: { in: [LegState.PENDING, LegState.SENT, LegState.UNKNOWN] } },
      data: {
        state: outcome === 'COMPLETED' ? LegState.CONFIRMED : LegState.FAILED,
        lastError: `Resolved by an owner (${actor.id})`,
      },
    });
    this.log.warn(`Transaction ${tx.id} resolved ${outcome} by owner ${actor.id}`);
    return { transactionId: tx.id, outcome };
  }

  async sweepWebhookGaps(): Promise<number> {
    const since = new Date(Date.now() - 48 * 3_600_000);
    try {
      const deposits = await this.quidax.fetchAllSubUserDeposits({
        start_date: since.toISOString().slice(0, 10),
      });
      return this.deposits.sweepGaps(deposits);
    } catch (err) {
      this.log.error('Webhook gap sweep failed: ' + (err as Error).message);
      return 0;
    }
  }

  /** M10: one server per run, the lease kept until it expires (see JobLeaseService). */
  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'reconcile' })
  async scheduled(): Promise<void> {
    if (!this.leases) return this.runScheduled();
    await this.leases.run('reconcile', 25 * 60_000, () => this.runScheduled(), { keep: true });
  }

  async runScheduled(): Promise<void> {
    const [drift, legs, gaps] = await Promise.all([
      this.checkInvariants(),
      this.resolveStuckLegs(),
      this.sweepWebhookGaps(),
    ]);

    const broken = drift.filter((d) => !d.withinTolerance);
    if (broken.length > 0) {
      this.log.error('INVARIANT DRIFT: ' + broken.map((b) => b.asset + '=' + b.drift).join(', '));
      for (const row of broken) {
        if (
          await this.inventory.recentlyAlerted(AlertType.RECONCILIATION_DRIFT, row.asset, 3_600_000)
        ) {
          continue;
        }
        await this.inventory.recordAlert(AlertType.RECONCILIATION_DRIFT, row.asset, row);
      }
    }
    if (legs > 0 || gaps > 0) {
      this.log.warn(
        'Reconciliation: resolved ' + legs + ' leg(s), recovered ' + gaps + ' deposit(s)',
      );
    }
  }
}
