import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AlertType, LegState, SettlementLegKind, TxStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuidaxClient } from '../quidax/quidax.client';
import { LedgerService } from '../ledger/ledger.service';
import { SettlementService } from '../trades/settlement.service';
import { DepositsService } from '../deposits/deposits.service';
import { InventoryService } from '../inventory/inventory.service';
import { Decimal, ZERO, dec } from '../common/money';

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
        withinTolerance:
          unreadable > 0 ? true : drift.abs().lte(dec(ReconciliationService.TOLERANCE)),
        partial: unreadable > 0,
      });
    }

    this.log.debug(`Reconciled ${scanned} sub-account(s) across ${rows.length} asset(s)`);
    return rows;
  }

  /**
   * Resolve legs whose outcome is unknown by asking Quidax what happened.
   * This is the ONLY correct response to a timeout on a write.
   */
  async resolveStuckLegs(): Promise<number> {
    const stuck = await this.prisma.settlementLeg.findMany({
      where: {
        state: { in: [LegState.UNKNOWN, LegState.SENT] },
        updatedAt: { lt: new Date(Date.now() - 60_000) },
      },
      include: { transaction: true },
      take: 50,
    });

    let resolved = 0;
    for (const leg of stuck) {
      try {
        // A TRANSFER_IN was sent BY the sub-account (sell, fee sweep); everything
        // else was sent by main. Asking the wrong account returns 404 and the leg
        // stays stuck forever.
        const sender =
          leg.kind === SettlementLegKind.TRANSFER_IN
            ? await this.settlement.quidaxIdFor(leg.transaction.userId)
            : 'me';

        const upstream = await this.quidax.fetchWithdrawalByReference(leg.reference, sender);
        if (!upstream) continue;

        const done = upstream.status?.toLowerCase() === 'done';
        await this.prisma.settlementLeg.update({
          where: { id: leg.id },
          data: { state: done ? LegState.CONFIRMED : LegState.FAILED, quidaxRef: upstream.id },
        });

        if (!done && leg.transaction.status === TxStatus.RECONCILING) {
          await this.settlement.reverse(leg.transactionId, 'Confirmed failed upstream');
        }
        resolved++;
      } catch (err) {
        this.log.warn('Could not resolve leg ' + leg.reference + ': ' + (err as Error).message);
      }
    }
    return resolved;
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

  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'reconcile' })
  async scheduled(): Promise<void> {
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
